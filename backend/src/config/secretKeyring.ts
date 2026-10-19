import { createHash } from "crypto";
import { logger } from "../utils/logger";
import { secretKeyVerificationsTotal } from "../utils/metrics";

/**
 * Secret rotation keyrings for JWT signing and webhook HMAC keys (#1456).
 * Design note: docs/design/secret-rotation.md.
 *
 * A keyring holds exactly one *current* key (used to sign and verify) and at
 * most one *previous* key (verify-only) that is accepted until its overlap
 * window closes at `expiresAt`. Every key has a key id (kid). Verification
 * picks the key by kid and never falls back to "try everything" for a kid it
 * does not know, so a token or webhook naming an unknown/retired kid is
 * rejected even if its signature would happen to match some other key.
 *
 * Env contract (per purpose, e.g. PREFIX = JWT_SECRET):
 *   PREFIX                      current secret (required for JWT)
 *   PREFIX_KID                  optional explicit kid for the current secret
 *   PREFIX_PREVIOUS             previous secret, verify-only
 *   PREFIX_PREVIOUS_KID         optional explicit kid for the previous secret
 *   PREFIX_PREVIOUS_EXPIRES_AT  ISO-8601 end of the overlap window (required
 *                               whenever PREFIX_PREVIOUS is set)
 * Without an explicit kid, the kid is a short SHA-256 fingerprint of the
 * secret, so it is stable across restarts and replicas without coordination.
 */

export type SecretPurpose = "jwt" | "webhook";
export type KeySlot = "current" | "previous";

export interface SigningKey {
  kid: string;
  secret: string;
  slot: KeySlot;
  /** Only set on the previous key: end of its verify-only window. */
  expiresAt?: Date;
}

export interface SecretKeyring {
  purpose: SecretPurpose;
  current: SigningKey;
  previous?: SigningKey;
}

export type RotationState = "stable" | "rotating" | "previous_expired";

export interface RotationReadiness {
  purpose: SecretPurpose;
  state: RotationState;
  currentKid: string | null;
  previousKid: string | null;
  previousExpiresAt: string | null;
  /** Fatal misconfigurations; non-empty means the process must not start. */
  errors: string[];
  /** Non-fatal findings for operators (logged at boot). */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

export const ENV_PREFIX: Record<SecretPurpose, string> = {
  jwt: "JWT_SECRET",
  webhook: "ORACLE_WEBHOOK_SECRET",
};

/** Minimum secret length enforced for each purpose. */
export const MIN_SECRET_LENGTH: Record<SecretPurpose, number> = { jwt: 32, webhook: 16 };

/** Longest overlap window we allow; a longer one is a forgotten rotation. */
export const MAX_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000;

const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function fingerprintKid(secret: string): string {
  return `fp-${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

/**
 * Validate the rotation configuration for one purpose without throwing.
 * Used both at boot (validateConfig) and by loadKeyring.
 */
export function checkRotationReadiness(purpose: SecretPurpose, env: Env = process.env, now: Date = new Date()): RotationReadiness {
  const prefix = ENV_PREFIX[purpose];
  const min = MIN_SECRET_LENGTH[purpose];
  const errors: string[] = [];
  const warnings: string[] = [];

  const current = read(env, prefix);
  const previous = read(env, `${prefix}_PREVIOUS`);
  const expiresRaw = read(env, `${prefix}_PREVIOUS_EXPIRES_AT`);
  const currentKid = read(env, `${prefix}_KID`) ?? (current ? fingerprintKid(current) : null);
  const previousKid = read(env, `${prefix}_PREVIOUS_KID`) ?? (previous ? fingerprintKid(previous) : null);

  if (!current) {
    if (purpose === "jwt") errors.push(`${prefix} must be set`);
    if (previous) errors.push(`${prefix}_PREVIOUS is set but ${prefix} is not`);
  } else if (current.length < min) {
    // Webhook secrets predate this check; keep them bootable but visible.
    (purpose === "jwt" ? errors : warnings).push(`${prefix} must be at least ${min} characters`);
  }

  for (const [name, kid] of [[`${prefix}_KID`, read(env, `${prefix}_KID`)], [`${prefix}_PREVIOUS_KID`, read(env, `${prefix}_PREVIOUS_KID`)]] as const) {
    if (kid && !KID_PATTERN.test(kid)) errors.push(`${name} must match ${KID_PATTERN}`);
  }

  let previousExpiresAt: Date | null = null;
  let state: RotationState = "stable";

  if (expiresRaw && !previous) errors.push(`${prefix}_PREVIOUS_EXPIRES_AT is set but ${prefix}_PREVIOUS is not`);

  if (previous) {
    state = "rotating";
    if (previous.length < min) errors.push(`${prefix}_PREVIOUS must be at least ${min} characters`);
    if (current && previous === current) errors.push(`${prefix}_PREVIOUS must differ from ${prefix}`);
    if (currentKid && previousKid && currentKid === previousKid) errors.push(`${prefix}_KID and ${prefix}_PREVIOUS_KID must differ`);
    if (!expiresRaw) {
      errors.push(`${prefix}_PREVIOUS_EXPIRES_AT is required while ${prefix}_PREVIOUS is set (bounded overlap window)`);
    } else {
      const parsed = new Date(expiresRaw);
      if (Number.isNaN(parsed.getTime())) {
        errors.push(`${prefix}_PREVIOUS_EXPIRES_AT must be an ISO-8601 timestamp`);
      } else {
        previousExpiresAt = parsed;
        if (parsed.getTime() - now.getTime() > MAX_OVERLAP_MS) {
          errors.push(`${prefix}_PREVIOUS_EXPIRES_AT is more than 30 days away; overlap windows must be short`);
        }
        if (parsed.getTime() <= now.getTime()) {
          state = "previous_expired";
          warnings.push(`${prefix}_PREVIOUS expired at ${parsed.toISOString()} and is no longer accepted; remove it`);
        }
      }
    }
  }

  return {
    purpose,
    state,
    currentKid: current ? currentKid : null,
    previousKid: previous ? previousKid : null,
    previousExpiresAt: previousExpiresAt ? previousExpiresAt.toISOString() : null,
    errors,
    warnings,
  };
}

export class SecretConfigError extends Error {
  constructor(public readonly readiness: RotationReadiness) {
    super(`Invalid ${readiness.purpose} secret configuration: ${readiness.errors.join("; ")}`);
    this.name = "SecretConfigError";
  }
}

/**
 * Build the keyring from env. Returns null only for an unconfigured optional
 * purpose (webhook). Throws SecretConfigError on misconfiguration.
 */
export function loadKeyring(purpose: SecretPurpose, env: Env = process.env, now: Date = new Date()): SecretKeyring | null {
  const readiness = checkRotationReadiness(purpose, env, now);
  if (readiness.errors.length > 0) throw new SecretConfigError(readiness);
  const prefix = ENV_PREFIX[purpose];
  const current = read(env, prefix);
  if (!current) return null;
  const keyring: SecretKeyring = { purpose, current: { kid: readiness.currentKid!, secret: current, slot: "current" } };
  const previous = read(env, `${prefix}_PREVIOUS`);
  if (previous && readiness.previousExpiresAt) {
    keyring.previous = { kid: readiness.previousKid!, secret: previous, slot: "previous", expiresAt: new Date(readiness.previousExpiresAt) };
  }
  return keyring;
}

function previousIsLive(keyring: SecretKeyring, now: Date): keyring is SecretKeyring & { previous: SigningKey } {
  return !!keyring.previous && !!keyring.previous.expiresAt && keyring.previous.expiresAt.getTime() > now.getTime();
}

/**
 * Keys a verifier may try, in order.
 *  - kid given: exactly the key with that kid (if live), otherwise none.
 *  - kid absent (tokens/webhooks from before kids were rolled out): current,
 *    then the previous key while its window is open.
 */
export function verificationCandidates(keyring: SecretKeyring, kid: string | undefined, now: Date = new Date()): SigningKey[] {
  const live = previousIsLive(keyring, now) ? [keyring.current, keyring.previous] : [keyring.current];
  if (kid === undefined) return live;
  return live.filter((key) => key.kid === kid);
}

export type VerificationOutcome = "accepted" | "unknown_kid" | "bad_signature";

export function recordVerification(purpose: SecretPurpose, outcome: VerificationOutcome, slot: KeySlot | "none", kid: string | undefined): void {
  secretKeyVerificationsTotal.inc({ purpose, slot, outcome });
  if (outcome === "accepted" && slot === "current") return; // hot path: metric only
  const entry = { event: "secret_key_verification", purpose, outcome, slot, kid: kid ?? null };
  if (outcome === "accepted") logger.info(entry, "verified with previous key during rotation overlap");
  else logger.warn(entry, "secret key verification rejected");
}

// ---- process-wide cached keyrings -------------------------------------------------

let cache: { env: string; keyrings: Partial<Record<SecretPurpose, SecretKeyring | null>> } | null = null;

function envSignature(purpose: SecretPurpose): string {
  const p = ENV_PREFIX[purpose];
  return [p, `${p}_KID`, `${p}_PREVIOUS`, `${p}_PREVIOUS_KID`, `${p}_PREVIOUS_EXPIRES_AT`].map((k) => process.env[k] ?? "").join("\u0000");
}

/**
 * Keyring for `purpose` from process.env, cached until the relevant env vars
 * change (tests and hot-reloaded config see new values without a restart).
 */
export function getKeyring(purpose: SecretPurpose): SecretKeyring | null {
  const signature = `${envSignature("jwt")}\u0001${envSignature("webhook")}`;
  if (!cache || cache.env !== signature) cache = { env: signature, keyrings: {} };
  if (!(purpose in cache.keyrings)) cache.keyrings[purpose] = loadKeyring(purpose);
  return cache.keyrings[purpose] ?? null;
}
