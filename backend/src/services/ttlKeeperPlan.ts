/**
 * Bounded, idempotent TTL renewal planning (#1516).
 *
 * This module is pure: it takes a snapshot of observed chain state (per
 * contract: identity + per-critical-key TTL headroom) and a policy, and
 * returns a deterministic plan of which keys to renew and which to skip, and
 * why. Everything that touches I/O (RPC, transaction submission) lives in
 * `ttlKeeperService.ts`, so the boundary/edge-case rules below are unit
 * tested without a network.
 *
 * Design rules:
 * - **Fail closed on identity.** A key is renewable only when the observed
 *   contract id/network/version positively match the deployment manifest. Any
 *   uncertainty skips the whole contract.
 * - **Never renew an already-expired key.** An expired (archived) entry must
 *   be restored, not TTL-extended; reporting it as renewable would hide the
 *   real remediation.
 * - **Renew strictly below threshold.** Headroom equal to the threshold is
 *   healthy — the boundary is `<`, not `<=`.
 * - **Bounded and deterministic.** Candidates are ordered by urgency (lowest
 *   headroom first, then contract/key) and capped per-run and per-contract,
 *   so a mass-expiry event cannot turn into an unbounded transaction burst.
 *
 * @module
 */

export type TtlSkipReason =
  | "identity_uncertain"
  | "network_mismatch"
  | "version_mismatch"
  | "absent"
  | "unreadable"
  | "expired"
  | "healthy"
  | "rate_limited";

export type TtlHeadroomClass = "expired" | "critical" | "ok";

export interface TtlKeyObservation {
  key: string;
  /** Whether the contract reports the key as present in storage. */
  present: boolean;
  /** `liveUntilLedgerSeq` from RPC, or null when the entry could not be read. */
  liveUntilLedger: number | null;
}

export interface TtlContractObservation {
  contractId: string;
  contractKind: string;
  /** Network passphrase pinned by the deployment manifest. */
  manifestNetwork: string;
  /** Contract version pinned by the deployment manifest. */
  manifestVersion: number;
  /** Network passphrase observed on-chain, or null when unknown. */
  observedNetwork: string | null;
  /** Contract `version()` observed on-chain, or null when unknown. */
  observedVersion: number | null;
  keys: TtlKeyObservation[];
}

export interface TtlKeeperPolicy {
  /** Renew a key when its headroom is strictly below this many ledgers. */
  renewBelowLedgers: number;
  /** Hard cap on renewals proposed per run (across all contracts). */
  maxRenewalsPerRun: number;
  /** Hard cap on renewals proposed per contract per run. */
  maxRenewalsPerContract: number;
}

export interface RenewalTarget {
  contractId: string;
  contractKind: string;
  key: string;
  headroom: number;
  liveUntilLedger: number;
}

export interface SkippedTarget {
  contractId: string;
  contractKind: string;
  key: string | null;
  reason: TtlSkipReason;
  headroom: number | null;
}

export interface RenewalPlan {
  currentLedger: number;
  policy: TtlKeeperPolicy;
  renew: RenewalTarget[];
  skip: SkippedTarget[];
}

export const DEFAULT_TTL_KEEPER_POLICY: TtlKeeperPolicy = {
  renewBelowLedgers: 1_000,
  maxRenewalsPerRun: 25,
  maxRenewalsPerContract: 10,
};

/**
 * Classify headroom. `expired` is non-renewable via TTL extension; `critical`
 * is inside the renewal window; `ok` is healthy.
 */
export function classifyHeadroom(headroom: number, policy: TtlKeeperPolicy): TtlHeadroomClass {
  if (headroom <= 0) return "expired";
  if (headroom < policy.renewBelowLedgers) return "critical";
  return "ok";
}

type IdentityResult = { ok: true } | { ok: false; reason: TtlSkipReason };

function evaluateIdentity(observation: TtlContractObservation): IdentityResult {
  if (observation.observedVersion === null || observation.observedNetwork === null) {
    return { ok: false, reason: "identity_uncertain" };
  }
  if (observation.observedNetwork !== observation.manifestNetwork) {
    return { ok: false, reason: "network_mismatch" };
  }
  if (observation.observedVersion !== observation.manifestVersion) {
    return { ok: false, reason: "version_mismatch" };
  }
  return { ok: true };
}

/**
 * Build a renewal plan from observed state. Pure and deterministic: the same
 * input yields the same output, which is what makes a restart or a duplicate
 * keeper safe to reason about.
 */
export function planRenewals(
  observations: readonly TtlContractObservation[],
  context: { currentLedger: number; policy: TtlKeeperPolicy },
): RenewalPlan {
  const { currentLedger, policy } = context;
  const candidates: RenewalTarget[] = [];
  const skip: SkippedTarget[] = [];

  for (const observation of observations) {
    const identity = evaluateIdentity(observation);
    if (!identity.ok) {
      skip.push({
        contractId: observation.contractId,
        contractKind: observation.contractKind,
        key: null,
        reason: identity.reason,
        headroom: null,
      });
      continue;
    }

    for (const key of observation.keys) {
      const base = {
        contractId: observation.contractId,
        contractKind: observation.contractKind,
        key: key.key,
      };

      if (!key.present) {
        skip.push({ ...base, reason: "absent", headroom: null });
        continue;
      }
      if (key.liveUntilLedger === null) {
        skip.push({ ...base, reason: "unreadable", headroom: null });
        continue;
      }

      const headroom = key.liveUntilLedger - currentLedger;
      const klass = classifyHeadroom(headroom, policy);
      if (klass === "expired") {
        skip.push({ ...base, reason: "expired", headroom });
        continue;
      }
      if (klass === "ok") {
        skip.push({ ...base, reason: "healthy", headroom });
        continue;
      }
      candidates.push({
        ...base,
        headroom,
        liveUntilLedger: key.liveUntilLedger,
      });
    }
  }

  // Most urgent first; ties broken deterministically for stable plans.
  candidates.sort(
    (a, b) =>
      a.headroom - b.headroom ||
      a.contractId.localeCompare(b.contractId) ||
      a.key.localeCompare(b.key),
  );

  const renew: RenewalTarget[] = [];
  const perContract = new Map<string, number>();
  for (const candidate of candidates) {
    const used = perContract.get(candidate.contractId) ?? 0;
    if (renew.length >= policy.maxRenewalsPerRun || used >= policy.maxRenewalsPerContract) {
      skip.push({
        contractId: candidate.contractId,
        contractKind: candidate.contractKind,
        key: candidate.key,
        reason: "rate_limited",
        headroom: candidate.headroom,
      });
      continue;
    }
    renew.push(candidate);
    perContract.set(candidate.contractId, used + 1);
  }

  return { currentLedger, policy, renew, skip };
}

// ─── Deployment manifest validation ─────────────────────────────────────────

export interface DeploymentManifest {
  contractId: string;
  kind: string;
  network: string;
  version: number;
}

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/**
 * Validate raw deployment manifests. Only a manifest that passes can become a
 * renewal target — the keeper never renews a contract it merely found on the
 * network.
 */
export function parseDeploymentManifests(raw: unknown): DeploymentManifest[] {
  if (!Array.isArray(raw)) {
    throw new Error("deployment manifest must be a JSON array");
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`manifest[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const contractId = record.contractId;
    const kind = record.kind;
    const network = record.network;
    const version = record.version;

    if (typeof contractId !== "string" || !CONTRACT_ID_RE.test(contractId)) {
      throw new Error(`manifest[${index}].contractId must be a valid contract id (C...55)`);
    }
    if (typeof kind !== "string" || kind.length === 0) {
      throw new Error(`manifest[${index}].kind must be a non-empty string`);
    }
    if (typeof network !== "string" || network.length === 0) {
      throw new Error(`manifest[${index}].network must be a non-empty passphrase`);
    }
    if (!Number.isInteger(version) || (version as number) < 1) {
      throw new Error(`manifest[${index}].version must be a positive integer`);
    }
    if (seen.has(contractId)) {
      throw new Error(`manifest contains duplicate contractId ${contractId}`);
    }
    seen.add(contractId);
    return { contractId, kind, network, version: version as number };
  });
}

/**
 * Parse manifests from an environment variable (JSON), returning `[]` when
 * unset so callers can distinguish "not configured" from "configured empty".
 */
export function manifestsFromEnv(envValue: string | undefined): DeploymentManifest[] {
  if (!envValue || envValue.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch (error) {
    throw new Error(
      `TTL_KEEPER_MANIFESTS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseDeploymentManifests(parsed);
}
