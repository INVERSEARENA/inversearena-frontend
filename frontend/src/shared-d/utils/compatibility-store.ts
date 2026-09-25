import { z } from "zod";
import { ContractError, ContractErrorCode } from "@/shared-d/utils/contract-error";

/**
 * Client side of the backend compatibility manifest (#1491), served by
 * `GET /api/config/compatibility`. This module owns the schema this build can
 * interpret and how a single capability is evaluated against a manifest.
 *
 * Forward compatibility: unknown fields are stripped and capability names this
 * build does not know are ignored, so a newer backend can add either without
 * breaking this client. A `schemaVersion` this build does not support is
 * surfaced as its own failure (the user needs a newer app), never guessed at.
 */

export const SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;

/** Capabilities this build declares and checks before constructing a transaction. */
export const KNOWN_CAPABILITIES = ["join", "commit", "reveal", "claim", "admin"] as const;
export type CapabilityName = (typeof KNOWN_CAPABILITIES)[number];

const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  join: "joining arenas",
  commit: "committing a choice",
  reveal: "revealing a choice",
  claim: "claiming winnings",
  admin: "arena administration",
};

const envelopeSchema = z.object({ schemaVersion: z.number().int() });

const manifestSchema = z.object({
  schemaVersion: z.literal(SUPPORTED_MANIFEST_SCHEMA_VERSION),
  network: z.object({ passphrase: z.string().min(1) }),
  configRevision: z.number().int().positive(),
  generatedAt: z.string(),
  contracts: z.array(
    z.object({
      kind: z.string(),
      contractId: z.string(),
      version: z.number().int().nullable(),
      status: z.string(),
    }),
  ),
  // Statuses/reasons are kept as strings and interpreted in evaluateCapability
  // so a value added by a newer backend cannot fail validation of the rest.
  capabilities: z.record(
    z.string(),
    z.object({
      status: z.string(),
      reason: z.string().optional(),
      requiredVersion: z.number().int().optional(),
    }),
  ),
});

export type CompatibilityManifest = z.infer<typeof manifestSchema>;

export type ManifestParseResult =
  | { ok: true; manifest: CompatibilityManifest }
  | { ok: false; error: "invalid" | "unsupported_schema" | "network_mismatch" };

export function parseCompatibilityManifest(
  raw: unknown,
  expectedPassphrase: string,
): ManifestParseResult {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, error: "invalid" };
  if (envelope.data.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported_schema" };
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid" };
  if (parsed.data.network.passphrase !== expectedPassphrase) {
    return { ok: false, error: "network_mismatch" };
  }
  return { ok: true, manifest: parsed.data };
}

export type CapabilityBlockReason =
  | "unsupported"
  | "negotiation_failed"
  | "unrecognized_status"
  | "stale"
  | "network_mismatch"
  | "unsupported_schema";

export type CapabilityDecision =
  | { allowed: true; state: "supported" | "unverified" }
  | { allowed: false; reason: CapabilityBlockReason; message: string };

export function blockedDecision(
  name: CapabilityName,
  reason: CapabilityBlockReason,
  requiredVersion?: number,
): CapabilityDecision {
  const label = CAPABILITY_LABELS[name];
  const messages: Record<CapabilityBlockReason, string> = {
    unsupported: `This arena's contract does not support ${label} yet${
      requiredVersion === undefined ? "" : ` (needs contract version ${requiredVersion} or newer)`
    }. The deployment must be upgraded before this action is available; browsing still works.`,
    negotiation_failed: `Could not confirm that this deployment supports ${label}. Try again in a moment; browsing still works.`,
    unrecognized_status: `This app cannot tell whether ${label} is supported. Refresh to load the latest version, then try again.`,
    stale: `The compatibility check for ${label} is out of date and is being refreshed. Try again in a moment.`,
    network_mismatch:
      "This app and the server are configured for different networks. Switch networks or refresh, then try again.",
    unsupported_schema:
      "This version of the app is out of date. Refresh to update, then try again.",
  };
  return { allowed: false, reason, message: messages[reason] };
}

/** Decision for one capability from a validated manifest. Unlisted or `unknown` capabilities do not block. */
export function evaluateCapability(
  manifest: CompatibilityManifest,
  name: CapabilityName,
): CapabilityDecision {
  const entry = manifest.capabilities[name];
  if (!entry) return { allowed: true, state: "unverified" };

  switch (entry.status) {
    case "supported":
      return { allowed: true, state: "supported" };
    case "unknown":
      return { allowed: true, state: "unverified" };
    case "unsupported":
      return blockedDecision(
        name,
        entry.reason === "negotiation_failed" ? "negotiation_failed" : "unsupported",
        entry.requiredVersion,
      );
    default:
      return blockedDecision(name, "unrecognized_status");
  }
}

/**
 * Holds the latest validated compatibility manifest per scope (#1491) and
 * answers "may this client action run right now?" before a transaction is
 * constructed. A scope is an arena contract id, or null for the deployment
 * wide manifest fetched at startup.
 *
 * Fail-open only where the client genuinely cannot know: no manifest yet, or
 * a backend that predates the endpoint (404). Everything the backend or this
 * build can positively determine blocks, and read-only pages never consult
 * the store, so they stay available when a mutation capability is missing.
 */

/** A manifest older than this (no successful refresh) no longer justifies a decision. */
export const MANIFEST_MAX_AGE_MS = 5 * 60_000;

export type ApplyManifestResult =
  | "applied"
  | "ignored_older_revision"
  | "network_mismatch"
  | "unsupported_schema"
  | "invalid";

interface ScopeState {
  manifest: CompatibilityManifest | null;
  receivedAt: number;
  failure: "network_mismatch" | "unsupported_schema" | null;
  /** The backend answered 404: it predates the manifest endpoint. */
  legacyBackend: boolean;
}

export interface CompatibilityStore {
  /** Validate and store a manifest response. Older configRevisions never replace newer ones. */
  applyResponse: (scope: string | null, raw: unknown, expectedPassphrase: string) => ApplyManifestResult;
  markLegacyBackend: (scope: string | null) => void;
  getDecision: (name: CapabilityName, scope?: string | null) => CapabilityDecision;
  getManifest: (scope?: string | null) => CompatibilityManifest | null;
  /** Changes on every update; a stable snapshot for useSyncExternalStore. */
  getVersion: () => number;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
}

const GLOBAL_SCOPE = "*";
const scopeKey = (scope: string | null | undefined): string => scope ?? GLOBAL_SCOPE;

export function createCompatibilityStore(
  options: { now?: () => number; maxAgeMs?: number } = {},
): CompatibilityStore {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? MANIFEST_MAX_AGE_MS;
  const scopes = new Map<string, ScopeState>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  const decideFromScope = (name: CapabilityName, state: ScopeState | undefined): CapabilityDecision | null => {
    if (!state) return null;
    if (state.failure) return blockedDecision(name, state.failure);
    if (state.legacyBackend || !state.manifest) return { allowed: true, state: "unverified" };
    if (now() - state.receivedAt > maxAgeMs) return blockedDecision(name, "stale");
    return evaluateCapability(state.manifest, name);
  };

  return {
    applyResponse: (scope, raw, expectedPassphrase) => {
      const key = scopeKey(scope);
      const parsed = parseCompatibilityManifest(raw, expectedPassphrase);
      const previous = scopes.get(key);

      if (!parsed.ok) {
        if (parsed.error === "invalid") return "invalid";
        scopes.set(key, {
          manifest: previous?.manifest ?? null,
          receivedAt: previous?.receivedAt ?? now(),
          failure: parsed.error,
          legacyBackend: false,
        });
        notify();
        return parsed.error;
      }

      if (
        previous?.manifest &&
        !previous.failure &&
        parsed.manifest.configRevision < previous.manifest.configRevision
      ) {
        return "ignored_older_revision";
      }
      scopes.set(key, {
        manifest: parsed.manifest,
        receivedAt: now(),
        failure: null,
        legacyBackend: false,
      });
      notify();
      return "applied";
    },

    markLegacyBackend: (scope) => {
      const key = scopeKey(scope);
      if (scopes.get(key)?.manifest) return;
      scopes.set(key, { manifest: null, receivedAt: now(), failure: null, legacyBackend: true });
      notify();
    },

    getDecision: (name, scope) => {
      if (scope) {
        const scoped = decideFromScope(name, scopes.get(scopeKey(scope)));
        // A scoped manifest that cannot say (unknown) defers to the global one.
        if (scoped && (!scoped.allowed || scoped.state === "supported")) return scoped;
      }
      return decideFromScope(name, scopes.get(GLOBAL_SCOPE)) ?? { allowed: true, state: "unverified" };
    },

    getManifest: (scope) => scopes.get(scopeKey(scope))?.manifest ?? null,
    getVersion: () => version,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      scopes.clear();
      notify();
    },
  };
}

export const compatibilityStore = createCompatibilityStore();

/**
 * Throws a ContractError before any transaction is built or any wallet
 * prompt is shown when the required capability is not available. `scope` is
 * the arena contract id the action targets.
 */
export function assertCapability(
  name: CapabilityName,
  scope: string | null,
  fn: string,
  store: CompatibilityStore = compatibilityStore,
): void {
  const decision = store.getDecision(name, scope);
  if (!decision.allowed) {
    throw new ContractError({
      code: ContractErrorCode.VALIDATION_FAILED,
      message: decision.message,
      fn,
    });
  }
}
