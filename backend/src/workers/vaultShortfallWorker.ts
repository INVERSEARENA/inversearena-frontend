/**
 * Vault shortfall and liability drift monitor — issue #1637.
 *
 * Periodically compares each arena vault's on-chain balance against its
 * total outstanding liabilities (unpaid withdrawals + pending payouts).
 * A coverage ratio below 1.0 means the vault is insolvent: it cannot pay
 * all its obligations from its current balance.
 *
 * Events ingested:
 *   - `short`                  emitted by the rwa-adapter when a withdrawal
 *                              cannot be paid in full.
 *   - `vault_balance_decreased` emitted by the arena contract when the vault
 *                              balance drops below a configured floor.
 *
 * Alert behaviour:
 *   - coverage < WARN_THRESHOLD  → Sentry warning + metric update
 *   - coverage < CRIT_THRESHOLD  → Sentry error  + metric update
 *   - Duplicate alerts within DEDUP_WINDOW_MS are suppressed.
 */

import { Gauge, Counter } from "prom-client";
import { register } from "../utils/metrics";
import { logger, reportErrorToSentry } from "../utils/logger";

// ── Configurable thresholds ────────────────────────────────────────────────────

const WARN_THRESHOLD = parseFloat(process.env.VAULT_WARN_COVERAGE_RATIO ?? "1.05");
const CRIT_THRESHOLD = parseFloat(process.env.VAULT_CRIT_COVERAGE_RATIO ?? "1.00");
const DEDUP_WINDOW_MS = parseInt(process.env.VAULT_ALERT_DEDUP_MS ?? "300000", 10); // 5 min
const CHECK_INTERVAL_MS = parseInt(process.env.VAULT_CHECK_INTERVAL_MS ?? "60000", 10); // 1 min

// ── Prometheus metrics ─────────────────────────────────────────────────────────

export const vaultCoverageRatio = new Gauge({
  name: "vault_coverage_ratio",
  help: "Vault balance divided by total liabilities (1.0 = fully solvent)",
  labelNames: ["arena_id"],
  registers: [register],
});

export const vaultShortfallEventsTotal = new Counter({
  name: "vault_shortfall_events_total",
  help: "Total number of shortfall events ingested",
  labelNames: ["arena_id", "event_type"],
  registers: [register],
});

export const vaultShortfallAlertsTotal = new Counter({
  name: "vault_shortfall_alerts_total",
  help: "Total number of shortfall alerts dispatched",
  labelNames: ["arena_id", "severity"],
  registers: [register],
});

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VaultSolvencySnapshot {
  arenaId: string;
  balance: bigint;
  liabilities: bigint;
  coverageRatio: number;
  checkedAt: Date;
}

export interface ShortfallEvent {
  type: "short" | "vault_balance_decreased";
  arenaId: string;
  amount?: bigint;
  timestamp: Date;
}

// ── Deduplication state ────────────────────────────────────────────────────────

const lastAlertAt = new Map<string, number>();

function shouldAlert(key: string): boolean {
  const now = Date.now();
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < DEDUP_WINDOW_MS) return false;
  lastAlertAt.set(key, now);
  return true;
}

// ── Core solvency check ────────────────────────────────────────────────────────

export function computeCoverageRatio(balance: bigint, liabilities: bigint): number {
  if (liabilities === 0n) return Infinity;
  return Number(balance) / Number(liabilities);
}

export function evaluateSolvency(snapshot: VaultSolvencySnapshot): void {
  const { arenaId, coverageRatio } = snapshot;

  vaultCoverageRatio.set({ arena_id: arenaId }, coverageRatio);

  if (coverageRatio < CRIT_THRESHOLD) {
    const key = `crit:${arenaId}`;
    if (shouldAlert(key)) {
      vaultShortfallAlertsTotal.inc({ arena_id: arenaId, severity: "critical" });
      logger.error(
        { arenaId, coverageRatio, balance: snapshot.balance, liabilities: snapshot.liabilities },
        "CRITICAL: vault coverage ratio below 1.0 — vault is insolvent"
      );
      reportErrorToSentry(
        new Error(`Vault ${arenaId} insolvent: coverage=${coverageRatio.toFixed(4)}`),
        { arenaId, coverageRatio, balance: snapshot.balance.toString() }
      );
    }
  } else if (coverageRatio < WARN_THRESHOLD) {
    const key = `warn:${arenaId}`;
    if (shouldAlert(key)) {
      vaultShortfallAlertsTotal.inc({ arena_id: arenaId, severity: "warning" });
      logger.warn(
        { arenaId, coverageRatio },
        "WARNING: vault coverage ratio below warning threshold"
      );
    }
  }
}

// ── Event ingestion ────────────────────────────────────────────────────────────

export function ingestShortfallEvent(event: ShortfallEvent): void {
  vaultShortfallEventsTotal.inc({
    arena_id: event.arenaId,
    event_type: event.type,
  });

  logger.warn(
    { event },
    `Shortfall event received: ${event.type} for arena ${event.arenaId}`
  );
}

// ── Periodic solvency check job ────────────────────────────────────────────────

export class VaultShortfallWorker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fetchSnapshots: () => Promise<VaultSolvencySnapshot[]>
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info("VaultShortfallWorker: starting periodic solvency checks");
    this.timer = setInterval(() => void this.runCheck(), CHECK_INTERVAL_MS);
    void this.runCheck(); // run immediately on start
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runCheck(): Promise<void> {
    try {
      const snapshots = await this.fetchSnapshots();
      for (const snapshot of snapshots) {
        evaluateSolvency(snapshot);
      }
      logger.debug({ count: snapshots.length }, "VaultShortfallWorker: solvency check complete");
    } catch (err) {
      logger.error({ err }, "VaultShortfallWorker: solvency check failed");
      reportErrorToSentry(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
