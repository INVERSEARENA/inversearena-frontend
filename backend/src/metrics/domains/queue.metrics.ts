/**
 * Queue & Worker Metrics Domain (#1750)
 */

import {
  createCounter,
  createGauge,
  createHistogram,
  register,
} from "../registry";
import { logger } from "../../utils/logger";
import {
  TX_CONFIRM_QUEUE,
  type QueueSnapshot,
  type QueueSnapshotSource,
} from "../../queues/txQueue";

export const QUEUE_LABELS = { queue: TX_CONFIRM_QUEUE } as const;
export const WORKER_LABELS = { worker: "tx-reconciler" } as const;

export const workerJobsPending = createGauge(
  {
    name: "worker_jobs_pending",
    help: "Number of pending worker jobs",
    labelNames: ["job_type"],
  },
  { domain: "queue" },
);

export const queueBacklogGauge = createGauge(
  {
    name: "inversearena_queue_backlog",
    help: "Number of jobs waiting to be processed",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueOldestAgeGauge = createGauge(
  {
    name: "inversearena_queue_oldest_age_seconds",
    help: "Age in seconds of the oldest pending queue job; -1 means unavailable",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueDelayedGauge = createGauge(
  {
    name: "inversearena_queue_delayed",
    help: "Number of jobs waiting for a retry backoff delay",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueActiveGauge = createGauge(
  {
    name: "inversearena_queue_active",
    help: "Number of jobs currently being processed",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueCapacityGauge = createGauge(
  {
    name: "inversearena_queue_capacity",
    help: "Configured worker concurrency for the queue",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueSaturationGauge = createGauge(
  {
    name: "inversearena_queue_saturation_ratio",
    help: "Active jobs divided by configured queue capacity",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueSnapshotAvailableGauge = createGauge(
  {
    name: "inversearena_queue_snapshot_available",
    help: "Whether the latest queue snapshot was available: 1 available, 0 unavailable",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueRefreshSuccessTotal = createCounter(
  {
    name: "inversearena_queue_refresh_success_total",
    help: "Successful queue snapshot refreshes",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueRefreshFailureTotal = createCounter(
  {
    name: "inversearena_queue_refresh_failure_total",
    help: "Failed queue snapshot refreshes",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const queueRefreshDuration = createHistogram(
  {
    name: "inversearena_queue_refresh_duration_seconds",
    help: "Queue snapshot refresh duration in seconds",
    labelNames: ["queue"],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  },
  { domain: "queue" },
);

export const workerJobAttemptsTotal = createCounter(
  {
    name: "inversearena_worker_job_attempts_total",
    help: "Total worker job processing attempts",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const workerJobRetriesTotal = createCounter(
  {
    name: "inversearena_worker_job_retries_total",
    help: "Total worker job retries",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const workerTerminalFailuresTotal = createCounter(
  {
    name: "inversearena_worker_terminal_failures_total",
    help: "Total worker jobs that reached a terminal failure",
    labelNames: ["queue", "reason"],
  },
  { domain: "queue" },
);

export const workerJobsSuccessTotal = createCounter(
  {
    name: "inversearena_worker_jobs_success_total",
    help: "Total worker jobs that completed successfully",
    labelNames: ["queue"],
  },
  { domain: "queue" },
);

export const workerJobProcessingDuration = createHistogram(
  {
    name: "inversearena_worker_job_processing_duration_seconds",
    help: "Worker job processing duration in seconds",
    labelNames: ["queue"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  },
  { domain: "queue" },
);

export const workerLifecycleEventsTotal = createCounter(
  {
    name: "inversearena_worker_lifecycle_events_total",
    help: "Worker lifecycle events",
    labelNames: ["worker", "event"],
  },
  { domain: "queue" },
);

export const workerActiveJobsGauge = createGauge(
  {
    name: "inversearena_worker_active_jobs",
    help: "Number of jobs currently active in the worker",
    labelNames: ["worker"],
  },
  { domain: "queue" },
);

// Initial values for clean scrape state
queueBacklogGauge.set(QUEUE_LABELS, -1);
queueOldestAgeGauge.set(QUEUE_LABELS, -1);
queueDelayedGauge.set(QUEUE_LABELS, -1);
queueActiveGauge.set(QUEUE_LABELS, -1);
queueCapacityGauge.set(QUEUE_LABELS, -1);
queueSaturationGauge.set(QUEUE_LABELS, -1);
queueSnapshotAvailableGauge.set(QUEUE_LABELS, 0);
workerActiveJobsGauge.set(WORKER_LABELS, 0);

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
