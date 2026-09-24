import {
  BullMqQueueSnapshotSource,
  TX_CONFIRM_QUEUE,
  type ConfirmJobData,
  type QueueSnapshot,
  type QueueSnapshotReader,
} from "../src/queues/txQueue";
import {
  queueBacklogGauge,
  queueCapacityGauge,
  queueDelayedGauge,
  queueOldestAgeGauge,
  queueRefreshDuration,
  queueRefreshFailureTotal,
  queueRefreshSuccessTotal,
  queueSnapshotAvailableGauge,
  queueActiveGauge,
  queueSaturationGauge,
  refreshQueueMetrics,
  workerJobAttemptsTotal,
  workerJobProcessingDuration,
  workerJobRetriesTotal,
  workerJobsSuccessTotal,
  workerTerminalFailuresTotal,
} from "../src/utils/metrics";
import {
  handleTxReconcilerFailure,
  observeTxJobActive,
  observeTxJobCompleted,
  type TxReconcilerStateMachine,
} from "../src/workers/txReconciler";
import { TransactionState } from "../src/domain/transactionState";
import { getTxWorkerConfig } from "../src/config/workerConfig";
import { logger } from "../src/utils/logger";
import type { Job } from "bullmq";

function queueReader(
  counts: Record<string, number>,
  jobs: Array<{ timestamp?: unknown }> = [],
): QueueSnapshotReader {
  return {
    getJobCounts: jest.fn().mockResolvedValue(counts),
    getJobs: jest.fn().mockResolvedValue(jobs),
  } as unknown as QueueSnapshotReader;
}

function snapshot(overrides: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    queue: TX_CONFIRM_QUEUE,
    backlog: 0,
    oldestJobTimestamp: null,
    oldestAgeSeconds: 0,
    delayed: 0,
    active: 0,
    capacity: 1,
    saturation: 0,
    ...overrides,
  };
}

function reconcilerJob(attemptsMade: number, attempts: number): Job<ConfirmJobData> {
  return {
    data: { transactionId: "tx-test" },
    attemptsMade,
    opts: { attempts },
  } as Job<ConfirmJobData>;
}

async function metricValue(
  metric: unknown,
  labels: Record<string, string>,
): Promise<number> {
  const value = await (
    metric as {
      get: () => Promise<{
        values: Array<{ labels: Record<string, string>; value: number }>;
      }>;
    }
  ).get();
  return (
    value.values.find((entry) =>
      Object.entries(labels).every(([key, label]) => entry.labels[key] === label),
    )?.value ?? 0
  );
}

describe("queue observability", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("derives backlog, oldest age, active, capacity, and saturation", async () => {
    const now = 1_000_000;
    const reader = queueReader(
      {
        waiting: 2,
        paused: 1,
        delayed: 1,
        prioritized: 0,
        "waiting-children": 1,
        active: 2,
      },
      [{ timestamp: now - 5_000 }, { timestamp: now - 1_000 }],
    );
    const source = new BullMqQueueSnapshotSource(reader, 4, () => now);

    const result = await source.getSnapshot();

    expect(result.backlog).toBe(3);
    expect(result.oldestAgeSeconds).toBe(5);
    expect(result.delayed).toBe(1);
    expect(result.active).toBe(2);
    expect(result.capacity).toBe(4);
    expect(result.saturation).toBe(0.5);
    expect(reader.getJobs).toHaveBeenCalledWith(
      ["waiting", "prioritized", "waiting-children"],
      0,
      0,
      true,
    );
  });

  it("represents an empty queue as zero rather than unavailable", async () => {
    const reader = queueReader({ active: 0 });
    const source = new BullMqQueueSnapshotSource(reader, 2, () => 10_000);

    const result = await source.getSnapshot();

    expect(result.backlog).toBe(0);
    expect(result.oldestAgeSeconds).toBe(0);
    expect(result.delayed).toBe(0);
    expect(result.active).toBe(0);
    expect(result.saturation).toBe(0);
    expect(reader.getJobs).not.toHaveBeenCalled();
  });

  it("coalesces concurrent snapshot reads", async () => {
    const reader = queueReader(
      { waiting: 1, active: 0 },
      [{ timestamp: 5_000 }],
    );
    const source = new BullMqQueueSnapshotSource(reader, 1, () => 10_000);

    const [first, second] = await Promise.all([
      source.getSnapshot(),
      source.getSnapshot(),
    ]);

    expect(first).toBe(second);
    expect(reader.getJobCounts).toHaveBeenCalledTimes(1);
    expect(reader.getJobs).toHaveBeenCalledTimes(1);
  });

  it("clamps future timestamps and keeps invalid timestamps unknown", async () => {
    const now = 10_000;
    const future = new BullMqQueueSnapshotSource(
      queueReader({ waiting: 1, active: 0 }, [{ timestamp: now + 1_000 }]),
      0,
      () => now,
    );
    const invalid = new BullMqQueueSnapshotSource(
      queueReader({ waiting: 1, active: 0 }, [{ timestamp: "invalid" }]),
      2,
      () => now,
    );
    const negative = new BullMqQueueSnapshotSource(
      queueReader({ waiting: 1, active: 0 }, [{ timestamp: -1 }]),
      2,
      () => now,
    );

    expect((await future.getSnapshot()).oldestAgeSeconds).toBe(0);
    expect((await future.getSnapshot()).saturation).toBe(0);
    expect((await invalid.getSnapshot()).oldestAgeSeconds).toBeNull();
    expect((await negative.getSnapshot()).oldestAgeSeconds).toBeNull();
  });

  it("refreshes gauges and distinguishes Redis failure from empty", async () => {
    const errorLog = jest.spyOn(logger, "error").mockImplementation(() => logger);
    const emptySource = { getSnapshot: jest.fn().mockResolvedValue(snapshot()) };
    const success = await refreshQueueMetrics(emptySource, { capacity: 3 });
    expect(success.available).toBe(true);
    expect(await metricValue(queueBacklogGauge, { queue: TX_CONFIRM_QUEUE })).toBe(0);
    expect(await metricValue(queueDelayedGauge, { queue: TX_CONFIRM_QUEUE })).toBe(0);
    expect(await metricValue(queueSnapshotAvailableGauge, { queue: TX_CONFIRM_QUEUE })).toBe(1);
    expect(await metricValue(queueRefreshSuccessTotal, { queue: TX_CONFIRM_QUEUE })).toBeGreaterThan(0);
    expect(await metricValue(queueRefreshDuration, { queue: TX_CONFIRM_QUEUE })).toBeGreaterThan(0);

    const failedSource = {
      getSnapshot: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    const failure = await refreshQueueMetrics(failedSource, { capacity: 3 });
    expect(failure.available).toBe(false);
    expect(await metricValue(queueBacklogGauge, { queue: TX_CONFIRM_QUEUE })).toBe(-1);
    expect(await metricValue(queueOldestAgeGauge, { queue: TX_CONFIRM_QUEUE })).toBe(-1);
    expect(await metricValue(queueDelayedGauge, { queue: TX_CONFIRM_QUEUE })).toBe(-1);
    expect(await metricValue(queueActiveGauge, { queue: TX_CONFIRM_QUEUE })).toBe(-1);
    expect(await metricValue(queueSaturationGauge, { queue: TX_CONFIRM_QUEUE })).toBe(-1);
    expect(await metricValue(queueCapacityGauge, { queue: TX_CONFIRM_QUEUE })).toBe(3);
    expect(await metricValue(queueSnapshotAvailableGauge, { queue: TX_CONFIRM_QUEUE })).toBe(0);
    expect(await metricValue(queueRefreshFailureTotal, { queue: TX_CONFIRM_QUEUE })).toBeGreaterThan(0);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "queue_snapshot_refresh_failure",
        queue: TX_CONFIRM_QUEUE,
        outcome: "failure",
      }),
      expect.any(String),
    );
  });

  it("records attempts, success, and processing latency", async () => {
    const job = reconcilerJob(1, 3);
    observeTxJobActive(job);
    observeTxJobCompleted(job);

    expect(
      await metricValue(workerJobAttemptsTotal, { queue: TX_CONFIRM_QUEUE }),
    ).toBeGreaterThan(0);
    expect(
      await metricValue(workerJobsSuccessTotal, { queue: TX_CONFIRM_QUEUE }),
    ).toBeGreaterThan(0);
    expect(
      await metricValue(workerJobProcessingDuration, { queue: TX_CONFIRM_QUEUE }),
    ).toBeGreaterThan(0);
  });

  it("records retry and terminal outcomes without changing the branch", async () => {
    const markDead = jest.fn(async () => undefined);
    const stateMachine = {
      confirmSubmitted: jest.fn(async () => TransactionState.SUBMITTED),
      markDead,
    } satisfies TxReconcilerStateMachine;

    await handleTxReconcilerFailure(
      reconcilerJob(1, 3),
      new Error("temporary"),
      stateMachine,
    );
    expect(markDead).not.toHaveBeenCalled();

    await handleTxReconcilerFailure(
      reconcilerJob(3, 3),
      new Error("permanent"),
      stateMachine,
    );
    expect(markDead).toHaveBeenCalledWith(
      "tx-test",
      "Confirmation failed after 3 attempts: permanent",
    );
    expect(
      await metricValue(workerJobRetriesTotal, { queue: TX_CONFIRM_QUEUE }),
    ).toBeGreaterThan(0);
    expect(
      await metricValue(workerTerminalFailuresTotal, {
        queue: TX_CONFIRM_QUEUE,
        reason: "retries_exhausted",
      }),
    ).toBeGreaterThan(0);
  });

  it("publishes a queue-source snapshot and failure state through the metrics boundary", async () => {
    const reader = queueReader(
      { waiting: 1, active: 1, delayed: 2 },
      [{ timestamp: 8_000 }],
    );
    const source = new BullMqQueueSnapshotSource(reader, 2, () => 10_000);

    await expect(refreshQueueMetrics(source)).resolves.toMatchObject({
      available: true,
      snapshot: {
        backlog: 1,
        oldestAgeSeconds: 2,
        delayed: 2,
        active: 1,
        capacity: 2,
        saturation: 0.5,
      },
    });
    expect(await metricValue(queueBacklogGauge, { queue: TX_CONFIRM_QUEUE })).toBe(1);
    expect(await metricValue(queueSnapshotAvailableGauge, { queue: TX_CONFIRM_QUEUE })).toBe(1);

    const failedSource = {
      getSnapshot: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    await expect(refreshQueueMetrics(failedSource, { capacity: 2 })).resolves.toEqual({
      available: false,
    });
    expect(await metricValue(queueSnapshotAvailableGauge, { queue: TX_CONFIRM_QUEUE })).toBe(0);
  });

  it("keeps the configured worker capacity and rejects invalid values", () => {
    expect(getTxWorkerConfig({ TX_WORKER_CONCURRENCY: "6" })).toEqual({
      concurrency: 6,
      capacity: 6,
    });
    expect(() => getTxWorkerConfig({ TX_WORKER_CONCURRENCY: "0" })).toThrow();
  });
});
