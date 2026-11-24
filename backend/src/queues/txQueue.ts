/**
 * Separated, prioritised BullMQ queues (#1839).
 *
 * Three queues replace the single tx-confirm queue:
 *   1. `payout-confirm`  — high-priority, low concurrency (winner payouts)
 *   2. `tx-reconcile`    — bulk background, higher concurrency
 *   3. `notify`          — notification fan-out, medium priority
 *
 * Each queue has its own concurrency, retry policy, and metrics label. The
 * legacy `TX_CONFIRM_QUEUE` constant and `ConfirmJobData` type are preserved
 * for backward compatibility during the rolling deploy window.
 *
 * Time:  O(1) per enqueue / snapshot read
 * Space: O(queues) = O(3) constant
 */

import { Queue, type JobType } from "bullmq";
import { env } from "../config/env";
import type { PayoutJobPayload, ReconcileJobPayload, NotificationJobPayload } from "./jobDefinition";

// ─── Queue names ──────────────────────────────────────────────────────────────

/** High-priority winner payout confirmation queue. */
export const PAYOUT_QUEUE = "payout-confirm" as const;

/** Bulk background transaction reconciliation queue. */
export const RECONCILE_QUEUE = "tx-reconcile" as const;

/** Notification fan-out queue. */
export const NOTIFICATION_QUEUE = "notify" as const;

/**
 * @deprecated Use PAYOUT_QUEUE or RECONCILE_QUEUE.
 * Kept during rolling deploy; remove after all workers have been restarted.
 */
export const TX_CONFIRM_QUEUE = PAYOUT_QUEUE;

// ─── Backlog state filter (shared across all queues) ──────────────────────────

export const TX_QUEUE_BACKLOG_STATES: JobType[] = [
  "waiting",
  "prioritized",
  "waiting-children",
];

// ─── Legacy type alias for backward compatibility ─────────────────────────────

/** @deprecated Use PayoutJobPayload or ReconcileJobPayload */
export interface ConfirmJobData {
  transactionId: string;
}

// ─── Snapshot types ───────────────────────────────────────────────────────────

export interface QueueSnapshot {
  queue: string;
  backlog: number;
  oldestJobTimestamp: number | null;
  oldestAgeSeconds: number | null;
  delayed: number;
  active: number;
  capacity: number;
  saturation: number;
  /** Number of terminal failures (dead-lettered) in the last collection window. */
  failures: number;
}

export interface QueueSnapshotSource {
  getSnapshot(): Promise<QueueSnapshot>;
}

export type QueueSnapshotReader = Pick<
  Queue,
  "getJobCounts" | "getJobs" | "getFailed"
>;

// ─── Multi-queue snapshot aggregator ─────────────────────────────────────────

/** Combined snapshot across all three queues. */
export interface MultiQueueSnapshot {
  payout: QueueSnapshot;
  reconcile: QueueSnapshot;
  notification: QueueSnapshot;
}

export interface MultiQueueSnapshotSource {
  getMultiSnapshot(): Promise<MultiQueueSnapshot>;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function countFor(counts: Record<string, number>, state: JobType): number {
  const value = counts[state];
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid queue count for ${state}`);
  }
  return Math.floor(value);
}

function oldestTimestamp(jobs: Array<{ timestamp?: unknown }>): number | null {
  let oldest: number | null = null;
  for (const job of jobs) {
    const rawTimestamp = job?.timestamp;
    const timestamp =
      rawTimestamp instanceof Date ? rawTimestamp.getTime() : rawTimestamp;
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      timestamp < 0
    ) {
      continue;
    }
    oldest = oldest === null ? timestamp : Math.min(oldest, timestamp);
  }
  return oldest;
}

// ─── Single-queue snapshot source ─────────────────────────────────────────────

export class BullMqQueueSnapshotSource implements QueueSnapshotSource {
  private readonly capacity: number;
  private readonly now: () => number;
  private inFlight: Promise<QueueSnapshot> | null = null;

  constructor(
    private readonly queue: QueueSnapshotReader,
    private readonly queueName: string,
    capacity: number,
    now: () => number = Date.now,
  ) {
    if (!Number.isFinite(capacity) || capacity < 0) {
      throw new Error("Queue capacity must be a finite non-negative number");
    }
    this.capacity = Math.floor(capacity);
    this.now = now;
  }

  async getSnapshot(): Promise<QueueSnapshot> {
    if (this.inFlight !== null) return this.inFlight;
    const pending = this.readSnapshot();
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  private async readSnapshot(): Promise<QueueSnapshot> {
    const counts = await this.queue.getJobCounts();
    const backlog = TX_QUEUE_BACKLOG_STATES.reduce(
      (total, state) => total + countFor(counts, state),
      0,
    );
    const active = countFor(counts, "active");
    const delayed = countFor(counts, "delayed");
    const failures = countFor(counts, "failed");
    const jobs =
      backlog === 0
        ? []
        : await this.queue.getJobs(TX_QUEUE_BACKLOG_STATES, 0, 0, true);
    const oldestJobTimestamp = oldestTimestamp(jobs);
    const measuredNow = this.now();
    const now = Number.isFinite(measuredNow) ? measuredNow : Date.now();
    const oldestAgeSeconds =
      backlog === 0
        ? 0
        : oldestJobTimestamp === null
          ? null
          : Math.max(0, (now - oldestJobTimestamp) / 1000);

    return {
      queue: this.queueName,
      backlog,
      oldestJobTimestamp,
      oldestAgeSeconds,
      delayed,
      active,
      capacity: this.capacity,
      saturation: this.capacity === 0 ? 0 : active / this.capacity,
      failures,
    };
  }
}

// ─── Dead-letter path ─────────────────────────────────────────────────────────

export interface DeadLetterReason {
  queue: string;
  jobId: string | undefined;
  reason: string;
  raw: unknown;
}

/**
 * Records an invalid or unroutable job to the dead-letter path.
 * Emits a structured log entry — never throws.
 */
export function deadLetterJob(entry: DeadLetterReason): void {
  // Import logger lazily to avoid circular dep at module level
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { logger } = require("../utils/logger") as typeof import("../utils/logger");
  logger.error(
    { deadLetter: true, ...entry },
    "job_dead_lettered: invalid or unroutable payload",
  );
}

// ─── Redis connection ─────────────────────────────────────────────────────────

function redisConnectionOpts() {
  const url = env.REDIS_URL ?? "redis://localhost:6379";
  return { url };
}

// ─── Queue factories ──────────────────────────────────────────────────────────

/**
 * High-priority payout confirmation queue.
 * Low concurrency (default 2) — winner payouts must not be blocked by bulk work.
 * High retry count with exponential backoff to tolerate transient Soroban RPC errors.
 */
export function createPayoutQueue(): Queue<PayoutJobPayload> {
  return new Queue<PayoutJobPayload>(PAYOUT_QUEUE, {
    connection: redisConnectionOpts(),
    defaultJobOptions: {
      attempts: 15,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
      priority: 1, // BullMQ: lower number = higher priority
    },
  });
}

/**
 * Bulk reconciliation queue.
 * Higher concurrency (default 10), lower priority, more relaxed retry policy.
 */
export function createReconcileQueue(): Queue<ReconcileJobPayload> {
  return new Queue<ReconcileJobPayload>(RECONCILE_QUEUE, {
    connection: redisConnectionOpts(),
    defaultJobOptions: {
      attempts: 10,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
      priority: 10,
    },
  });
}

/**
 * Notification queue.
 * Medium priority; failures are non-critical (webhooks/push are best-effort).
 */
export function createNotificationQueue(): Queue<NotificationJobPayload> {
  return new Queue<NotificationJobPayload>(NOTIFICATION_QUEUE, {
    connection: redisConnectionOpts(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 50,
      removeOnFail: 200,
      priority: 5,
    },
  });
}

/**
 * @deprecated Use createPayoutQueue / createReconcileQueue.
 * Retained for backward-compat during rolling deploy.
 */
export function createTxQueue(): Queue<ConfirmJobData> {
  return createPayoutQueue() as unknown as Queue<ConfirmJobData>;
}
