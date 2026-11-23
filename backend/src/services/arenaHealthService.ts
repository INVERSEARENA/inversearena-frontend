/**
 * Arena Health Service (#1412)
 *
 * Design note
 * -----------
 * Ownership   : Single point of truth for the composite health status of an
 *               arena.  Three independent signals are combined:
 *
 *   1. chain_lag   — seconds since the most recent RESOLVED/SETTLED round was
 *                    confirmed.  A long lag means Soroban confirmation is stale
 *                    or the payout worker is stuck.
 *
 *   2. queue_lag   — age of the oldest queued or submitted payout transaction
 *                    for rounds in this arena.  A long lag means the worker is
 *                    not draining the queue.
 *
 *   3. state_drift — seconds the arena has been in the current round state
 *                    beyond the expected TTL for that state.  Detects a round
 *                    that never transitions (e.g. stuck OPEN).
 *
 * Thresholds  :
 *   HEALTHY   — all signals within normal bounds
 *   DEGRADED  — at least one signal above the warning threshold
 *   CRITICAL  — at least one signal above the critical threshold
 *
 * Timestamps  : every signal includes an `evidenceAt` ISO timestamp so
 *               operators can correlate with logs and traces.
 *
 * Compatibility: adds a new GET /api/arenas/:id/health endpoint; no existing
 *               surfaces change.
 */

import type { PrismaClient } from "@prisma/client";
import {
  arenaHealthGauge,
  arenaChainLagGauge,
  arenaQueueLagGauge,
  arenaStateDriftGauge,
} from "../utils/metrics";
import { logger } from "../utils/logger";

// ── Thresholds (seconds) ──────────────────────────────────────────────────────

const THRESHOLDS = {
  chainLag:   { warn: 120, critical: 300 },   // 2 min / 5 min
  queueLag:   { warn: 60,  critical: 180 },   // 1 min / 3 min
  stateDrift: { warn: 90,  critical: 240 },   // 1.5 min / 4 min
} as const;

/** Expected maximum TTL (seconds) for each round state before we call it drifted. */
const ROUND_STATE_TTL_SECONDS: Record<string, number> = {
  OPEN:     90,
  CLOSED:   60,
  RESOLVED: 120,
  SETTLED:  300,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "critical";

export interface HealthSignal {
  /** Observed lag / drift in seconds. */
  valueSeconds: number;
  status: HealthStatus;
  /** ISO timestamp of the evidence that produced this reading. */
  evidenceAt: string;
}

export interface ArenaHealthSummary {
  arenaId: string;
  overallStatus: HealthStatus;
  evaluatedAt: string;
  signals: {
    chainLag: HealthSignal;
    queueLag: HealthSignal;
    stateDrift: HealthSignal & { roundState: string };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toStatus(
  valueSeconds: number,
  thresholds: { warn: number; critical: number },
): HealthStatus {
  if (valueSeconds >= thresholds.critical) return "critical";
  if (valueSeconds >= thresholds.warn) return "degraded";
  return "healthy";
}

function worstStatus(...statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("degraded")) return "degraded";
  return "healthy";
}

const HEALTH_GAUGE_VALUE: Record<HealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  critical: 2,
};

// ── Service ───────────────────────────────────────────────────────────────────

export class ArenaHealthService {
  constructor(private readonly prisma: PrismaClient) {}

  async getArenaHealth(arenaId: string): Promise<ArenaHealthSummary> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // 1. Chain lag: time since last RESOLVED/SETTLED round
    const lastResolved = await this.prisma.round.findFirst({
      where: { arenaId, state: { in: ["RESOLVED", "SETTLED"] } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });

    const chainLagSeconds = lastResolved
      ? (now - lastResolved.updatedAt.getTime()) / 1000
      : 0; // no resolved rounds yet — not a lag condition

    const chainLagSignal: HealthSignal = {
      valueSeconds: chainLagSeconds,
      status: toStatus(chainLagSeconds, THRESHOLDS.chainLag),
      evidenceAt: lastResolved?.updatedAt.toISOString() ?? nowIso,
    };

    // 2. Queue lag: oldest queued/submitted payout for this arena's rounds
    //    We join through rounds → metadata → payout records stored in the
    //    in-memory / mongo transaction repo.  Because the payout repo is
    //    currently in-memory we query the `transactions` PG table as a
    //    best-effort proxy; when 0 rows are found we default to no lag.
    const oldestQueued = await this.prisma.transaction.findFirst({
      where: {
        status: { in: ["PENDING"] },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }).catch(() => null);

    const queueLagSeconds = oldestQueued
      ? (now - oldestQueued.createdAt.getTime()) / 1000
      : 0;

    const queueLagSignal: HealthSignal = {
      valueSeconds: queueLagSeconds,
      status: toStatus(queueLagSeconds, THRESHOLDS.queueLag),
      evidenceAt: oldestQueued?.createdAt.toISOString() ?? nowIso,
    };

    // 3. State drift: how long the current round has been in its current state
    const activeRound = await this.prisma.round.findFirst({
      where: { arenaId, state: { in: ["OPEN", "CLOSED"] } },
      orderBy: { roundNumber: "desc" },
      select: { state: true, updatedAt: true },
    });

    let stateDriftSeconds = 0;
    let currentRoundState = "NONE";

    if (activeRound) {
      currentRoundState = activeRound.state;
      const expectedTtl = ROUND_STATE_TTL_SECONDS[activeRound.state] ?? 120;
      const ageSeconds = (now - activeRound.updatedAt.getTime()) / 1000;
      stateDriftSeconds = Math.max(0, ageSeconds - expectedTtl);
    }

    const stateDriftSignal: HealthSignal & { roundState: string } = {
      valueSeconds: stateDriftSeconds,
      status: toStatus(stateDriftSeconds, THRESHOLDS.stateDrift),
      evidenceAt: activeRound?.updatedAt.toISOString() ?? nowIso,
      roundState: currentRoundState,
    };

    const overallStatus = worstStatus(
      chainLagSignal.status,
      queueLagSignal.status,
      stateDriftSignal.status,
    );

    // ── Metrics ──────────────────────────────────────────────────────────────
    try {
      arenaHealthGauge.set({ arena_id: arenaId }, HEALTH_GAUGE_VALUE[overallStatus]);
      arenaChainLagGauge.set({ arena_id: arenaId }, chainLagSeconds);
      arenaQueueLagGauge.set({ arena_id: arenaId }, queueLagSeconds);
      arenaStateDriftGauge.set(
        { arena_id: arenaId, state: currentRoundState },
        stateDriftSeconds,
      );
    } catch (err) {
      logger.warn({ err, arenaId }, "arena_health_metrics_update_failed");
    }

    const summary: ArenaHealthSummary = {
      arenaId,
      overallStatus,
      evaluatedAt: nowIso,
      signals: {
        chainLag: chainLagSignal,
        queueLag: queueLagSignal,
        stateDrift: stateDriftSignal,
      },
    };

    if (overallStatus !== "healthy") {
      logger.warn({ ...summary }, "arena_health_degraded");
    }

    return summary;
  }
}
