import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { PrismaClient } from '@prisma/client';
import { logger } from "./logger";
import {
  TX_CONFIRM_QUEUE,
  type QueueSnapshot,
  type QueueSnapshotSource,
} from "../queues/txQueue";

export const register = new Registry();

// HTTP Metrics
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const workerJobsPending = new Gauge({
  name: 'worker_jobs_pending',
  help: 'Number of pending worker jobs',
  labelNames: ['job_type'],
  registers: [register],
});

const QUEUE_LABELS = { queue: TX_CONFIRM_QUEUE } as const;
const WORKER_LABELS = { worker: "tx-reconciler" } as const;

export const queueBacklogGauge = new Gauge({
  name: "inversearena_queue_backlog",
  help: "Number of jobs waiting to be processed",
  labelNames: ["queue"],
  registers: [register],
});

export const queueOldestAgeGauge = new Gauge({
  name: "inversearena_queue_oldest_age_seconds",
  help: "Age in seconds of the oldest pending queue job; -1 means unavailable",
  labelNames: ["queue"],
  registers: [register],
});

export const queueDelayedGauge = new Gauge({
  name: "inversearena_queue_delayed",
  help: "Number of jobs waiting for a retry backoff delay",
  labelNames: ["queue"],
  registers: [register],
});

export const queueActiveGauge = new Gauge({
  name: "inversearena_queue_active",
  help: "Number of jobs currently being processed",
  labelNames: ["queue"],
  registers: [register],
});

export const queueCapacityGauge = new Gauge({
  name: "inversearena_queue_capacity",
  help: "Configured worker concurrency for the queue",
  labelNames: ["queue"],
  registers: [register],
});

export const queueSaturationGauge = new Gauge({
  name: "inversearena_queue_saturation_ratio",
  help: "Active jobs divided by configured queue capacity",
  labelNames: ["queue"],
  registers: [register],
});

export const queueSnapshotAvailableGauge = new Gauge({
  name: "inversearena_queue_snapshot_available",
  help: "Whether the latest queue snapshot was available: 1 available, 0 unavailable",
  labelNames: ["queue"],
  registers: [register],
});

export const queueRefreshSuccessTotal = new Counter({
  name: "inversearena_queue_refresh_success_total",
  help: "Successful queue snapshot refreshes",
  labelNames: ["queue"],
  registers: [register],
});

export const queueRefreshFailureTotal = new Counter({
  name: "inversearena_queue_refresh_failure_total",
  help: "Failed queue snapshot refreshes",
  labelNames: ["queue"],
  registers: [register],
});

export const queueRefreshDuration = new Histogram({
  name: "inversearena_queue_refresh_duration_seconds",
  help: "Queue snapshot refresh duration in seconds",
  labelNames: ["queue"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const serverTimeIssuedTotal = new Counter({
  name: "inversearena_server_time_issued_total",
  help: "Total signed server-time tokens issued",
  registers: [register],
});

export const serverTimeVerifiedTotal = new Counter({
  name: "inversearena_server_time_verified_total",
  help: "Total signed server-time token verification attempts, by outcome",
  labelNames: ["outcome"],
  registers: [register],
});

export const watchlistOperationsTotal = new Counter({
  name: "inversearena_watchlist_operations_total",
  help: "Total arena watchlist watch/unwatch operations, by operation and result",
  labelNames: ["operation", "result"],
  registers: [register],
});

export const diagnosticsRunsTotal = new Counter({
  name: "inversearena_transaction_diagnostics_runs_total",
  help: "Total transaction simulation diagnostics runs, by outcome",
  labelNames: ["outcome"],
  registers: [register],
});

export const diagnosticsRunDuration = new Histogram({
  name: "inversearena_transaction_diagnostics_duration_seconds",
  help: "Transaction simulation diagnostics duration in seconds",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const workerJobAttemptsTotal = new Counter({
  name: "inversearena_worker_job_attempts_total",
  help: "Total worker job processing attempts",
  labelNames: ["queue"],
  registers: [register],
});

export const workerJobRetriesTotal = new Counter({
  name: "inversearena_worker_job_retries_total",
  help: "Total worker job retries",
  labelNames: ["queue"],
  registers: [register],
});

export const workerTerminalFailuresTotal = new Counter({
  name: "inversearena_worker_terminal_failures_total",
  help: "Total worker jobs that reached a terminal failure",
  labelNames: ["queue", "reason"],
  registers: [register],
});

export const workerJobsSuccessTotal = new Counter({
  name: "inversearena_worker_jobs_success_total",
  help: "Total worker jobs that completed successfully",
  labelNames: ["queue"],
  registers: [register],
});

export const workerJobProcessingDuration = new Histogram({
  name: "inversearena_worker_job_processing_duration_seconds",
  help: "Worker job processing duration in seconds",
  labelNames: ["queue"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const workerLifecycleEventsTotal = new Counter({
  name: "inversearena_worker_lifecycle_events_total",
  help: "Worker lifecycle events",
  labelNames: ["worker", "event"],
  registers: [register],
});

export const workerActiveJobsGauge = new Gauge({
  name: "inversearena_worker_active_jobs",
  help: "Number of jobs currently active in the worker",
  labelNames: ["worker"],
  registers: [register],
});

queueBacklogGauge.set(QUEUE_LABELS, -1);
queueOldestAgeGauge.set(QUEUE_LABELS, -1);
queueDelayedGauge.set(QUEUE_LABELS, -1);
queueActiveGauge.set(QUEUE_LABELS, -1);
queueCapacityGauge.set(QUEUE_LABELS, -1);
queueSaturationGauge.set(QUEUE_LABELS, -1);
queueSnapshotAvailableGauge.set(QUEUE_LABELS, 0);
workerActiveJobsGauge.set(WORKER_LABELS, 0);

// Transaction Metrics
export const txsConfirmedTotal = new Counter({
  name: 'txs_confirmed_total',
  help: 'Total number of confirmed transactions',
  labelNames: ['status'],
  registers: [register],
});

// Round Metrics
export const roundResolutionsTotal = new Counter({
  name: 'round_resolutions_total',
  help: 'Total number of round resolutions',
  labelNames: ['status'],
  registers: [register],
});

export const roundResolutionDuration = new Histogram({
  name: 'round_resolution_duration_seconds',
  help: 'Round resolution duration in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const arenaStateTransitionsTotal = new Counter({
  name: 'inversearena_arena_state_transitions_total',
  help: 'Total number of arena round state transitions',
  labelNames: ['from_state', 'to_state'],
  registers: [register],
});

export const arenasActiveGauge = new Gauge({
  name: 'inversearena_arenas_active_total',
  help: 'Number of arenas with an unresolved active round',
  registers: [register],
});

export const playersEliminatedTotal = new Counter({
  name: 'inversearena_players_eliminated_total',
  help: 'Total players eliminated across all arenas',
  registers: [register],
});

export const payoutsSuccessTotal = new Counter({
  name: 'inversearena_payouts_success_total',
  help: 'Total successful prize payouts',
  labelNames: ['asset'],
  registers: [register],
});

export const payoutsDeadLetterTotal = new Counter({
  name: 'inversearena_payouts_dead_letter_total',
  help: 'Total payouts moved to dead status after exhausting failed retries',
  labelNames: ['reason'],
  registers: [register],
});

// 0 = closed (healthy), 1 = half-open (probing), 2 = open (failing)
export const sorobanCircuitBreakerState = new Gauge({
  name: 'inversearena_soroban_circuit_breaker_state',
  help: 'Soroban RPC circuit breaker state: 0=closed, 1=half-open, 2=open',
  registers: [register],
});

export const sorobanCircuitTransitionsTotal = new Counter({
  name: 'inversearena_soroban_circuit_transitions_total',
  help: 'Total Soroban RPC circuit breaker state transitions',
  labelNames: ['to_state'],
  registers: [register],
});

export const maintenanceMutationsBlockedTotal = new Counter({
  name: 'inversearena_maintenance_mutations_blocked_total',
  help: 'Total mutating requests rejected because a maintenance window was active',
  labelNames: ['method'],
  registers: [register],
});

export const maintenanceWindowsScheduledTotal = new Counter({
  name: 'inversearena_maintenance_windows_scheduled_total',
  help: 'Total maintenance windows scheduled, by outcome',
  labelNames: ['status'],
  registers: [register],
});

export const transactionAccessDecisionsTotal = new Counter({
  name: 'inversearena_transaction_access_decisions_total',
  help: 'Transaction/payout status access decisions, by operation, outcome and (server-side only) reason',
  labelNames: ['operation', 'outcome', 'reason'],
  registers: [register],
});

export const payloadLimitRejectionsTotal = new Counter({
  name: 'inversearena_payload_limit_rejections_total',
  help: 'Untrusted payloads rejected by schema-level size/depth limits, by boundary and limit kind',
  labelNames: ['boundary', 'limit'],
  registers: [register],
});

export const secretKeyVerificationsTotal = new Counter({
  name: 'inversearena_secret_key_verifications_total',
  help: 'JWT/webhook signature verifications during key rotation, by purpose, matched key slot and outcome',
  labelNames: ['purpose', 'slot', 'outcome'],
  registers: [register],
});

export interface QueueMetricsRefreshResult {
  available: boolean;
  snapshot?: QueueSnapshot;
}

export interface QueueMetricsRefreshOptions {
  capacity?: number;
}

function isValidQueueSnapshot(snapshot: QueueSnapshot): boolean {
  return (
    snapshot.queue === TX_CONFIRM_QUEUE &&
    Number.isFinite(snapshot.backlog) &&
    snapshot.backlog >= 0 &&
    Number.isFinite(snapshot.delayed) &&
    snapshot.delayed >= 0 &&
    Number.isFinite(snapshot.active) &&
    snapshot.active >= 0 &&
    Number.isFinite(snapshot.capacity) &&
    snapshot.capacity >= 0 &&
    Number.isFinite(snapshot.saturation) &&
    snapshot.saturation >= 0 &&
    (snapshot.oldestAgeSeconds === null ||
      (Number.isFinite(snapshot.oldestAgeSeconds) &&
        snapshot.oldestAgeSeconds >= 0))
  );
}

function normalizedCapacity(capacity: number | undefined, fallback: number): number {
  const value = capacity ?? fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Queue capacity must be a finite non-negative number");
  }
  return Math.floor(value);
}

function setQueueUnavailable(capacity?: number): void {
  queueBacklogGauge.set(QUEUE_LABELS, -1);
  queueOldestAgeGauge.set(QUEUE_LABELS, -1);
  queueDelayedGauge.set(QUEUE_LABELS, -1);
  queueActiveGauge.set(QUEUE_LABELS, -1);
  queueSaturationGauge.set(QUEUE_LABELS, -1);
  queueSnapshotAvailableGauge.set(QUEUE_LABELS, 0);
  if (capacity !== undefined) {
    queueCapacityGauge.set(QUEUE_LABELS, normalizedCapacity(capacity, 0));
  } else {
    queueCapacityGauge.set(QUEUE_LABELS, -1);
  }
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(error.name)
    ? error.name
    : "QueueSnapshotError";
}

export async function refreshQueueMetrics(
  source: QueueSnapshotSource,
  options: QueueMetricsRefreshOptions = {},
): Promise<QueueMetricsRefreshResult> {
  const started = process.hrtime.bigint();
  try {
    const snapshot = await source.getSnapshot();
    if (!isValidQueueSnapshot(snapshot)) {
      throw new Error("Queue snapshot is invalid");
    }
    const capacity = normalizedCapacity(options.capacity, snapshot.capacity);
    const effectiveSnapshot: QueueSnapshot = {
      ...snapshot,
      capacity,
      saturation: capacity === 0 ? 0 : snapshot.active / capacity,
    };

    queueCapacityGauge.set(QUEUE_LABELS, capacity);
    queueBacklogGauge.set(QUEUE_LABELS, effectiveSnapshot.backlog);
    queueOldestAgeGauge.set(
      QUEUE_LABELS,
      effectiveSnapshot.oldestAgeSeconds ?? -1,
    );
    queueDelayedGauge.set(QUEUE_LABELS, effectiveSnapshot.delayed);
    queueActiveGauge.set(QUEUE_LABELS, effectiveSnapshot.active);
    queueSaturationGauge.set(QUEUE_LABELS, effectiveSnapshot.saturation);
    queueSnapshotAvailableGauge.set(QUEUE_LABELS, 1);
    queueRefreshSuccessTotal.inc(QUEUE_LABELS);
    return { available: true, snapshot: effectiveSnapshot };
  } catch (error) {
    logger.error(
      {
        event: "queue_snapshot_refresh_failure",
        queue: TX_CONFIRM_QUEUE,
        outcome: "failure",
        errorName: safeErrorName(error),
      },
      "Queue snapshot refresh failed",
    );
    try {
      setQueueUnavailable(options.capacity);
    } catch {
      queueCapacityGauge.set(QUEUE_LABELS, -1);
    }
    queueRefreshFailureTotal.inc(QUEUE_LABELS);
    return { available: false };
  } finally {
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    queueRefreshDuration.observe(QUEUE_LABELS, Math.max(0, elapsed));
  }
}

export async function refreshArenaMetrics(prisma: PrismaClient): Promise<void> {
  const activeRounds = await prisma.round.findMany({
    where: {
      state: {
        in: ['OPEN', 'CLOSED'],
      },
    },
    distinct: ['arenaId'],
    select: { arenaId: true },
  });

  arenasActiveGauge.set(activeRounds.length);
}
