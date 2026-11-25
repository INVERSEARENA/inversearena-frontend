/**
 * Prometheus metrics for treasury fee reconciliation (#1511). Registered on
 * the shared prom-client Registry (`backend/src/utils/metrics.ts`) so
 * they're served by the existing `/metrics` endpoint, mirroring the #1382
 * projection metrics' naming/labeling conventions
 * (`services/projection/arenaProjectionMetrics.ts`).
 */

import { Counter, Gauge, Histogram } from "prom-client";
import type { PrismaClient } from "@prisma/client";
import { register } from "../../utils/metrics";

export const treasuryIngestionRunsTotal = new Counter({
  name: "inversearena_treasury_ingestion_runs_total",
  help: "Total treasury reconciliation ingestion runs, by outcome",
  labelNames: ["result"] as const,
  registers: [register],
});

export const treasuryIngestionDurationSeconds = new Histogram({
  name: "inversearena_treasury_ingestion_duration_seconds",
  help: "Duration of a single treasury reconciliation ingestion run for one arena",
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const treasuryLeaseConflictsTotal = new Counter({
  name: "inversearena_treasury_lease_conflicts_total",
  help: "Total ingestion attempts that found an active lease held by another process",
  registers: [register],
});

export const treasuryRecordsByStatusTotal = new Counter({
  name: "inversearena_treasury_records_total",
  help: "Total treasury fee records written, by reconciliation status",
  labelNames: ["status"] as const,
  registers: [register],
});

export const treasuryDiscrepanciesTotal = new Counter({
  name: "inversearena_treasury_discrepancies_total",
  help: "Total discrepant treasury fee records, by discrepancy type",
  labelNames: ["discrepancy_type"] as const,
  registers: [register],
});

/** Gauge (not counter): the current unreconciled backlog, refreshed each time it's computed. */
export const treasuryUnreconciledCount = new Gauge({
  name: "inversearena_treasury_unreconciled_count",
  help: "Current count of pending/discrepant treasury fee records",
  labelNames: ["status"] as const,
  registers: [register],
});

export const treasuryUnreconciledAgeSeconds = new Gauge({
  name: "inversearena_treasury_unreconciled_age_seconds",
  help: "Age in seconds of the oldest unreconciled (pending or discrepant) treasury fee record",
  registers: [register],
});

export const treasuryUnreconciledValueAtomic = new Gauge({
  name: "inversearena_treasury_unreconciled_value_atomic",
  help: "Sum of expected_amount_atomic across discrepant treasury fee records, by asset",
  labelNames: ["asset"] as const,
  registers: [register],
});

/**
 * Recompute the unreconciled-backlog gauges from current `TreasuryFeeRecord`
 * state. Called from the `/metrics` endpoint's refresh list (mirrors
 * `refreshArenaMetrics`'s pattern in `utils/metrics.ts`) rather than on a
 * timer, so the exposed values are always as fresh as the last scrape.
 */
export async function refreshTreasuryMetrics(prisma: PrismaClient): Promise<void> {
  const unreconciled = await prisma.treasuryFeeRecord.findMany({
    where: { status: { in: ["pending", "discrepant"] } },
    select: { status: true, asset: true, expectedAmountAtomic: true, sourceLedgerClosedAt: true },
  });

  const countByStatus = new Map<string, number>();
  const valueByAsset = new Map<string, bigint>();
  let oldestLedgerClosedAt: Date | null = null;

  for (const record of unreconciled) {
    countByStatus.set(record.status, (countByStatus.get(record.status) ?? 0) + 1);
    if (record.status === "discrepant") {
      valueByAsset.set(record.asset, (valueByAsset.get(record.asset) ?? 0n) + record.expectedAmountAtomic);
    }
    if (!oldestLedgerClosedAt || record.sourceLedgerClosedAt < oldestLedgerClosedAt) {
      oldestLedgerClosedAt = record.sourceLedgerClosedAt;
    }
  }

  for (const status of ["pending", "discrepant"] as const) {
    treasuryUnreconciledCount.set({ status }, countByStatus.get(status) ?? 0);
  }
  for (const [asset, value] of valueByAsset) {
    // prom-client Gauges take `number`; atomic amounts here are bounded well
    // within Number.MAX_SAFE_INTEGER for this protocol's realistic pool
    // sizes (the stored value itself stays BigInt/exact — only the exported
    // metric is a float, which Prometheus requires anyway).
    treasuryUnreconciledValueAtomic.set({ asset }, Number(value));
  }
  treasuryUnreconciledAgeSeconds.set(
    oldestLedgerClosedAt ? (Date.now() - oldestLedgerClosedAt.getTime()) / 1000 : 0,
  );
}
