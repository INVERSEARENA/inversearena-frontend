// Feature flag rule evaluation (issue #1855). Pure and dependency-free so the
// backend and the frontend can run the exact same code: no Node APIs, and the
// percentage bucket uses a fixed 32-bit FNV-1a hash rather than a library. The
// Postgres model, the Redis cache and pub/sub, the /api/flags route and the
// admin UI call into this module; none of that lives here.

export type FlagRule =
  /** On for these wallets, whatever the percentage says. */
  | { kind: "allowlist"; wallets: string[] }
  /** On for this share of identities (0..100, up to two decimals), chosen by a stable hash. */
  | { kind: "percentage"; percent: number }
  /** The flag can only be on in these networks (passphrase or short name). */
  | { kind: "network"; networks: string[] };

export interface FeatureFlag {
  key: string;
  description?: string;
  /** Master switch: when false the flag is off for everyone. */
  enabled: boolean;
  /**
   * Allowlist and percentage rules are alternatives (any match turns the flag
   * on); a network rule is a gate that must also pass. With no allowlist and
   * no percentage rule, an enabled flag is on for everyone the gate admits.
   */
  rules: FlagRule[];
  owner?: string;
  /** ISO date; a flag past it evaluates off and is reported by `expiredFlags`. */
  expiresAt?: string;
  archived?: boolean;
}

export interface FlagContext {
  /** Connected wallet address, when there is one. */
  wallet?: string | null;
  /** Stable id for visitors with no wallet (a cookie id), so they bucket consistently too. */
  anonymousId?: string | null;
  network?: string | null;
  now?: Date;
}

const FLAG_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 32-bit FNV-1a over UTF-16 code units. Fixed, so every runtime buckets identically. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A flag's bucket for an identity: an integer 0..9999, stable for the same key and id. */
export function bucketOf(flagKey: string, identity: string): number {
  return fnv1a(`${flagKey}:${identity}`) % 10_000;
}

const normalizeWallet = (wallet: string) => wallet.trim().toUpperCase();

/** The identity used for bucketing: the wallet when present, else the anonymous id. */
function identityOf(ctx: FlagContext): string | null {
  const wallet = ctx.wallet?.trim();
  if (wallet) return `w:${normalizeWallet(wallet)}`;
  const anonymous = ctx.anonymousId?.trim();
  return anonymous ? `a:${anonymous}` : null;
}

export function isExpired(flag: Pick<FeatureFlag, "expiresAt">, now: Date = new Date()): boolean {
  if (!flag.expiresAt) return false;
  const at = Date.parse(flag.expiresAt);
  // An unreadable date is treated as expired: the safe answer is off.
  return Number.isNaN(at) || at <= now.getTime();
}

/** Returns an error message, or null when the flag is well formed. */
export function validateFlag(flag: FeatureFlag): string | null {
  if (!FLAG_KEY.test(flag.key)) return "Flag key must be 1-64 chars of a-z, 0-9, '.', '_' or '-'.";
  if (typeof flag.enabled !== "boolean") return "enabled must be a boolean.";
  if (flag.expiresAt !== undefined && Number.isNaN(Date.parse(flag.expiresAt))) return "expiresAt is not a valid date.";
  let percentages = 0;
  for (const rule of flag.rules) {
    if (rule.kind === "percentage") {
      percentages += 1;
      if (!Number.isFinite(rule.percent) || rule.percent < 0 || rule.percent > 100) return "Percentage must be between 0 and 100.";
      if (Math.round(rule.percent * 100) / 100 !== rule.percent) return "Percentage supports at most two decimals.";
    } else if (rule.kind === "allowlist") {
      if (!Array.isArray(rule.wallets) || rule.wallets.some((w) => typeof w !== "string" || w.trim() === "")) {
        return "Allowlist wallets must be non-empty strings.";
      }
    } else if (rule.kind === "network") {
      if (!Array.isArray(rule.networks) || rule.networks.length === 0) return "A network rule needs at least one network.";
    } else {
      return "Unknown rule kind.";
    }
  }
  return percentages > 1 ? "A flag can have only one percentage rule." : null;
}

/**
 * Whether `flag` is on for `ctx`. Archived, expired and disabled flags are off.
 * Anonymous visitors with no id never match a percentage rule, so a missing
 * identity cannot accidentally enable a rollout.
 */
export function isEnabled(flag: FeatureFlag, ctx: FlagContext = {}): boolean {
  if (flag.archived || !flag.enabled || isExpired(flag, ctx.now)) return false;

  for (const rule of flag.rules) {
    if (rule.kind === "network") {
      const network = ctx.network?.trim();
      if (!network || !rule.networks.includes(network)) return false;
    }
  }

  const audience = flag.rules.filter((r) => r.kind === "allowlist" || r.kind === "percentage");
  if (audience.length === 0) return true;

  const wallet = ctx.wallet?.trim();
  const identity = identityOf(ctx);
  for (const rule of audience) {
    if (rule.kind === "allowlist" && wallet && rule.wallets.some((w) => normalizeWallet(w) === normalizeWallet(wallet))) return true;
    if (rule.kind === "percentage" && identity !== null && bucketOf(flag.key, identity) < Math.round(rule.percent * 100)) return true;
  }
  return false;
}

/**
 * `isEnabled` that never throws: a malformed flag or a bad context turns the
 * flag off. This is the fail-safe used for kill switches and error paths.
 */
export function isEnabledSafe(flag: FeatureFlag, ctx: FlagContext = {}): boolean {
  try {
    return isEnabled(flag, ctx);
  } catch {
    return false;
  }
}

/** Evaluates every flag for one session, as returned by `/api/flags`. */
export function evaluateAll(flags: readonly FeatureFlag[], ctx: FlagContext = {}): Record<string, boolean> {
  return Object.fromEntries(flags.map((flag) => [flag.key, isEnabledSafe(flag, ctx)]));
}

/** Flags past their expiry that are still live, for the lint/CI check. */
export function expiredFlags(flags: readonly FeatureFlag[], now: Date = new Date()): FeatureFlag[] {
  return flags.filter((flag) => !flag.archived && isExpired(flag, now));
}
