/**
 * Wallet portfolio risk summary (#1691).
 *
 * A read-only, deterministic view of where a wallet's funds depend on degraded
 * integrations. It is not financial advice and makes no predictions. It groups
 * exact minor-unit exposure by asset, vault, oracle and lifecycle, attaches the
 * evidence each group rests on, and maps that evidence to one of three
 * non-advisory signals through a fixed ruleset.
 *
 * Rules:
 *  - Amounts are never converted across assets. Each group sums one asset only.
 *  - Positions are deduplicated by `positionId` before grouping, so a replayed
 *    position cannot inflate exposure.
 *  - Zero-value positions and positions observed past the snapshot ledger
 *    (ledger rollback) are excluded and listed with a reason, not summed.
 *  - Missing evidence is reported as `unavailable` with its reason. It is never
 *    filled with a default, and verified groups stay in the summary.
 *  - Severity is the maximum over a group's reasons. The wallet severity is the
 *    maximum over its groups.
 */

export const PORTFOLIO_RISK_VERSION = 1 as const;

export const PORTFOLIO_RISK_DISCLAIMER =
  "Informational only. These signals describe protocol data freshness and integration status. They are not financial advice and do not predict outcomes.";

export type RiskSeverity = "informational" | "attention" | "action_required";

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  informational: 0,
  attention: 1,
  action_required: 2,
};

export type ReserveStatus = "healthy" | "shortfall";
export type OracleFreshnessStatus = "fresh" | "warning" | "stale";
export type RegistryLifecycle = "active" | "deprecated";
export type ArenaHealthStatus = "healthy" | "degraded" | "critical";
export type PositionLifecycle = "open" | "active" | "finished" | "cancelled" | "settled";

export type Evidence<T> = { status: "available"; value: T } | { status: "unavailable"; reason: string };

export interface PortfolioPosition {
  positionId: string;
  /** `claimable` is a finished arena's unclaimed payout. `active` is stake still at play. */
  kind: "active" | "claimable";
  asset: string;
  vaultId: string;
  oracleId: string;
  arenaId: string;
  lifecycle: PositionLifecycle;
  /** Exact amount in minor units, as a decimal string. */
  amountMinor: string;
  /** Ledger at which this position was observed. */
  observedLedger: number;
}

export interface GroupEvidence {
  reserve: Evidence<ReserveStatus>;
  oracle: Evidence<OracleFreshnessStatus>;
  registry: Evidence<RegistryLifecycle>;
  arenaHealth: Evidence<ArenaHealthStatus>;
  contractVersion: Evidence<number>;
  /** Ledger the evidence was read at, or null when unknown. */
  ledger: number | null;
}

export interface PortfolioRiskInput {
  positions: readonly PortfolioPosition[];
  /** Ledger the summary is computed against. Positions observed later than this are rolled back. */
  snapshotLedger: number;
  /** Evidence keyed by group key (see `groupKey`). A group without an entry has no evidence at all. */
  evidence: Readonly<Record<string, GroupEvidence>>;
  /** Highest contract version this build understands. Newer versions cannot be assessed. */
  supportedContractVersion: number;
}

export interface RiskSignal {
  severity: RiskSeverity;
  /** Sorted, machine-readable reason codes. Informational signals may carry notices such as `claim_available`. */
  reasons: string[];
}

export interface PortfolioRiskGroup {
  key: string;
  asset: string;
  vaultId: string;
  oracleId: string;
  lifecycle: PositionLifecycle;
  exposureMinor: string;
  positionCount: number;
  evidence: GroupEvidence | null;
  signal: RiskSignal;
  /** `complete` when every evidence source is available, otherwise `partial`. */
  dataAvailability: "complete" | "partial";
}

export interface ExcludedPosition {
  positionId: string;
  reason: "zero_value" | "invalid_amount" | "ledger_rollback" | "duplicate";
}

export interface PortfolioRiskSummary {
  version: typeof PORTFOLIO_RISK_VERSION;
  snapshotLedger: number;
  disclaimer: string;
  overall: RiskSignal;
  groups: PortfolioRiskGroup[];
  excluded: ExcludedPosition[];
}

export function groupKey(position: Pick<PortfolioPosition, "asset" | "vaultId" | "oracleId" | "lifecycle">): string {
  return [position.asset, position.vaultId, position.oracleId, position.lifecycle].join("|");
}

interface Signal {
  severity: RiskSeverity;
  reason: string;
}

/** Reason codes produced for one group's evidence and lifecycle. */
function signalFor(group: { lifecycle: PositionLifecycle; evidence: GroupEvidence | null; supported: number }): RiskSignal {
  const signals: Signal[] = [];
  const { evidence } = group;

  if (!evidence) {
    signals.push({ severity: "attention", reason: "evidence_unavailable" });
  } else {
    const check = <T>(source: Evidence<T>, name: string, onValue: (value: T) => Signal | null) => {
      if (source.status === "unavailable") {
        signals.push({ severity: "attention", reason: `${name}_unavailable` });
        return;
      }
      const outcome = onValue(source.value);
      if (outcome) signals.push(outcome);
    };

    check(evidence.reserve, "reserve", (status) =>
      status === "shortfall" ? { severity: "action_required", reason: "reserve_shortfall" } : null,
    );
    check(evidence.oracle, "oracle", (status) => {
      if (status === "stale") return { severity: "attention", reason: "oracle_stale" };
      if (status === "warning") return { severity: "attention", reason: "oracle_warning" };
      return null;
    });
    check(evidence.registry, "registry", (status) =>
      status === "deprecated" ? { severity: "attention", reason: "integration_deprecated" } : null,
    );
    check(evidence.arenaHealth, "arena_health", (status) => {
      if (status === "critical") return { severity: "action_required", reason: "arena_critical" };
      if (status === "degraded") return { severity: "attention", reason: "arena_degraded" };
      return null;
    });
    check(evidence.contractVersion, "contract_version", (version) =>
      version > group.supported ? { severity: "attention", reason: "unsupported_contract_version" } : null,
    );
  }

  // Finished arenas with unclaimed payouts are actionable, but that is only information.
  if (group.lifecycle === "finished") {
    signals.push({ severity: "informational", reason: "claim_available" });
  }

  return finalizeSignal(signals);
}

function finalizeSignal(signals: readonly Signal[]): RiskSignal {
  const severity = signals.reduce<RiskSeverity>(
    (max, signal) => (SEVERITY_RANK[signal.severity] > SEVERITY_RANK[max] ? signal.severity : max),
    "informational",
  );
  const reasons = [...new Set(signals.map((signal) => signal.reason))].sort();
  return { severity, reasons };
}

/** Parse a non-negative minor-unit amount. Returns null for anything that is not a plain integer string. */
function parseMinorAmount(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

/**
 * Compute the portfolio risk summary. Pure and deterministic. Malformed
 * positions are excluded with a reason, and unavailable evidence becomes an
 * explicit `unavailable` reason, so the function never throws.
 */
export function computePortfolioRiskSummary(input: PortfolioRiskInput): PortfolioRiskSummary {
  const excluded: ExcludedPosition[] = [];
  const seen = new Set<string>();
  const groups = new Map<string, { position: PortfolioPosition; amount: bigint; count: number }>();

  for (const position of input.positions) {
    if (seen.has(position.positionId)) {
      excluded.push({ positionId: position.positionId, reason: "duplicate" });
      continue;
    }
    seen.add(position.positionId);

    if (position.observedLedger > input.snapshotLedger) {
      excluded.push({ positionId: position.positionId, reason: "ledger_rollback" });
      continue;
    }

    const amount = parseMinorAmount(position.amountMinor);
    if (amount === null) {
      excluded.push({ positionId: position.positionId, reason: "invalid_amount" });
      continue;
    }
    if (amount === 0n) {
      excluded.push({ positionId: position.positionId, reason: "zero_value" });
      continue;
    }

    const key = groupKey(position);
    const group = groups.get(key);
    if (group) {
      group.amount += amount;
      group.count += 1;
    } else {
      groups.set(key, { position, amount, count: 1 });
    }
  }

  const summaries: PortfolioRiskGroup[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, { position, amount, count }]) => {
      const evidence = input.evidence[key] ?? null;
      const sources = evidence
        ? [evidence.reserve, evidence.oracle, evidence.registry, evidence.arenaHealth, evidence.contractVersion]
        : [];
      const complete = evidence !== null && sources.every((source) => source.status === "available");
      return {
        key,
        asset: position.asset,
        vaultId: position.vaultId,
        oracleId: position.oracleId,
        lifecycle: position.lifecycle,
        exposureMinor: amount.toString(),
        positionCount: count,
        evidence,
        signal: signalFor({ lifecycle: position.lifecycle, evidence, supported: input.supportedContractVersion }),
        dataAvailability: complete ? "complete" : "partial",
      };
    });

  // Every non-informational group signal has at least one reason, so the maximum
  // over reasons equals the maximum over groups, and the overall reasons are the union.
  const overall = finalizeSignal(
    summaries.flatMap((group) => group.signal.reasons.map((reason) => ({ severity: group.signal.severity, reason }))),
  );

  return {
    version: PORTFOLIO_RISK_VERSION,
    snapshotLedger: input.snapshotLedger,
    disclaimer: PORTFOLIO_RISK_DISCLAIMER,
    overall,
    groups: summaries,
    excluded,
  };
}
