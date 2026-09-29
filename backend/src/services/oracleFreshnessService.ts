/**
 * Oracle Freshness Policy Service (#1512)
 *
 * Classifies how trustworthy an oracle rate reading is, and gives
 * yield-dependent backend mutations (round resolution today) a single place
 * to reject stale/unavailable data with a typed, recoverable error instead
 * of silently trusting a caller-submitted yield number. See
 * `docs/ORACLE_FRESHNESS_POLICY_DESIGN.md` for the full design note.
 *
 * Ownership: this module owns classification and the reject/accept decision
 * only. It does not itself read the chain — `OracleReader` (below) is
 * injected so this file stays independently testable from
 * `onChainReader.ts`'s much larger dependency graph, mirroring
 * `disputeEvidenceService.ts`'s `CommitStatusReader` pattern (#1517).
 */

import { getOracleFreshnessConfig, type OracleFreshnessConfig } from "../config/oracleFreshnessConfig";
import {
  oracleFreshnessClassificationTotal,
  oracleStalenessSecondsGauge,
  yieldDependentActionsBlockedTotal,
} from "../utils/metrics";

export type OracleFreshness = "fresh" | "warning" | "stale" | "unavailable";

/** Local mirror of `onChainReader.ts`'s `OnChainOracleReading` — see that file's own
 * doc comment for why this is duplicated rather than imported. */
export interface OracleReading {
  rateBps: number;
  observedAt: number;
  sourceVersion: number;
}

export interface OracleReader {
  getOracleReading(oracleContractId: string): Promise<OracleReading | null>;
}

export interface FreshnessClassification {
  freshness: OracleFreshness;
  /** Seconds since the observation, or `null` when `freshness === "unavailable"`. */
  ageSeconds: number | null;
  reading: OracleReading | null;
}

/**
 * Classify an oracle reading's age against a freshness policy.
 *
 * Mirrors `contract/arena/src/oracle.rs`'s `classify_freshness` exactly
 * (same threshold semantics, same treatment of a missing/future-dated
 * observation) so the backend's independent check and the on-chain
 * `resolve_round` check agree on what counts as stale.
 */
export function classifyFreshness(
  now: number,
  reading: OracleReading | null,
  policy: Pick<OracleFreshnessConfig, "maxAgeSeconds" | "warnAgeSeconds">,
): FreshnessClassification {
  if (!reading) {
    return { freshness: "unavailable", ageSeconds: null, reading: null };
  }
  if (reading.observedAt === 0 || reading.observedAt > now) {
    // No observation ever recorded, or a future-dated one (clock/ledger
    // divergence) — both are evidence the reading cannot be trusted.
    return { freshness: "stale", ageSeconds: null, reading };
  }
  const ageSeconds = now - reading.observedAt;
  if (ageSeconds >= policy.maxAgeSeconds) {
    return { freshness: "stale", ageSeconds, reading };
  }
  if (ageSeconds >= policy.warnAgeSeconds) {
    return { freshness: "warning", ageSeconds, reading };
  }
  return { freshness: "fresh", ageSeconds, reading };
}

/**
 * Raised by `assertFresh` when a yield-dependent mutation must not proceed.
 * Recoverable: the caller can retry once a fresh observation is published.
 */
export class StaleOracleDataError extends Error {
  constructor(
    readonly oracleContractId: string,
    readonly classification: FreshnessClassification,
  ) {
    super(
      `Oracle ${oracleContractId} data is ${classification.freshness}` +
        (classification.ageSeconds !== null ? ` (age ${classification.ageSeconds}s)` : ""),
    );
    this.name = "StaleOracleDataError";
  }
}

export class OracleFreshnessService {
  constructor(
    private readonly reader: OracleReader,
    private readonly config: OracleFreshnessConfig = getOracleFreshnessConfig(),
  ) {}

  async classify(oracleContractId: string, now: number = Math.floor(Date.now() / 1000)): Promise<FreshnessClassification> {
    const reading = await this.reader.getOracleReading(oracleContractId);
    const classification = classifyFreshness(now, reading, this.config);
    oracleFreshnessClassificationTotal.inc({ classification: classification.freshness });
    if (classification.ageSeconds !== null) {
      oracleStalenessSecondsGauge.set({ oracle_contract: oracleContractId }, classification.ageSeconds);
    }
    return classification;
  }

  /**
   * Reject a yield-dependent action if the oracle's data is `stale`.
   * `unavailable` is deliberately NOT rejected here — a reader that cannot
   * reach the oracle at all keeps the existing liveness-first behavior
   * (mirrors `contract/arena/src/oracle.rs::fetch_yield_bps`'s doc comment);
   * only a reading that *is* known and too old blocks the action.
   */
  async assertFresh(oracleContractId: string, action: string): Promise<FreshnessClassification> {
    const classification = await this.classify(oracleContractId);
    if (classification.freshness === "stale") {
      yieldDependentActionsBlockedTotal.inc({ action, reason: "stale_oracle_data" });
      throw new StaleOracleDataError(oracleContractId, classification);
    }
    return classification;
  }
}

/**
 * Keeper-facing status (#1512 acceptance criteria: "identifies overdue
 * updates without performing external data fetching"). Reads only the
 * already-cached/on-chain classification this service already computed —
 * never calls out to an off-chain provider (Ondo/Band/etc.) itself.
 */
export interface KeeperOracleStatus {
  oracleContractId: string;
  freshness: OracleFreshness;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  warnAgeSeconds: number;
  overdue: boolean;
  checkedAt: string;
}

export function toKeeperStatus(
  oracleContractId: string,
  classification: FreshnessClassification,
  config: Pick<OracleFreshnessConfig, "maxAgeSeconds" | "warnAgeSeconds">,
): KeeperOracleStatus {
  return {
    oracleContractId,
    freshness: classification.freshness,
    ageSeconds: classification.ageSeconds,
    maxAgeSeconds: config.maxAgeSeconds,
    warnAgeSeconds: config.warnAgeSeconds,
    overdue: classification.freshness === "stale" || classification.freshness === "warning",
    checkedAt: new Date().toISOString(),
  };
}
