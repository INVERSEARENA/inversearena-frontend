import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import {
  ArenaPollConcurrencyLimiter,
  pollerConcurrencyLimiter,
  setPollerConcurrencyConfig,
  getPollerConcurrencyStats,
  resetPollerConcurrencyLimiterForTest,
  type PollerExecutionState,
} from "../src/cache/arenaPoller";

describe("Arena Poller Bounded Concurrency & Backpressure Unit Tests (#1433)", () => {
  beforeEach(() => {
    resetPollerConcurrencyLimiterForTest();
  });

  test("normal path: executes single poll task within concurrency limit", async () => {
    const limiter = new ArenaPollConcurrencyLimiter({ maxConcurrency: 5, maxQueueDepth: 10 });
    let executed = false;

    const result = await limiter.executeBounded("arena-1", async () => {
      executed = true;
    });

    assert.strictEqual(result, true);
    assert.strictEqual(executed, true);
    assert.strictEqual(limiter.getStats().totalProcessed, 1);
    assert.strictEqual(limiter.getExecutionState("arena-1"), "IDLE");
  });

  test("single-flight deduplication: rejects duplicate concurrent execution for same arena", async () => {
    const limiter = new ArenaPollConcurrencyLimiter({ maxConcurrency: 5, maxQueueDepth: 10 });

    let resolveActivePoll!: () => void;
    const activePollPromise = new Promise<void>((resolve) => {
      resolveActivePoll = resolve;
    });

    // Start active poll for arena-1
    const task1Promise = limiter.executeBounded("arena-1", async () => {
      await activePollPromise;
    });

    // Verify arena-1 state is POLLING
    assert.strictEqual(limiter.getExecutionState("arena-1"), "POLLING");

    // Second trigger for arena-1 while task 1 is in-flight
    const task2Result = await limiter.executeBounded("arena-1", async () => {
      assert.fail("Duplicate poll should not execute");
    });

    assert.strictEqual(task2Result, false, "Duplicate trigger should be deduplicated");

    // Finish task 1
    resolveActivePoll();
    await task1Promise;

    assert.strictEqual(limiter.getExecutionState("arena-1"), "IDLE");
  });

  test("boundary path: queues tasks up to maxQueueDepth when maxConcurrency is reached", async () => {
    const limiter = new ArenaPollConcurrencyLimiter({ maxConcurrency: 2, maxQueueDepth: 3 });

    const resolvers: Array<() => void> = [];

    // Occupy 2 worker slots
    const task1 = limiter.executeBounded("arena-1", () => new Promise((res) => resolvers.push(res)));
    const task2 = limiter.executeBounded("arena-2", () => new Promise((res) => resolvers.push(res)));

    assert.strictEqual(limiter.getStats().activePolls, 2);

    // Queue 2 tasks under capacity
    const task3Promise = limiter.executeBounded("arena-3", async () => {});
    const task4Promise = limiter.executeBounded("arena-4", async () => {});

    assert.strictEqual(limiter.getExecutionState("arena-3"), "QUEUED");
    assert.strictEqual(limiter.getExecutionState("arena-4"), "QUEUED");
    assert.strictEqual(limiter.getStats().queueDepth, 2);

    // Resolve first active task -> task3 should drain and complete
    resolvers[0]?.();
    await task1;
    await task3Promise;

    assert.strictEqual(limiter.getStats().activePolls, 1);

    // Resolve second active task -> task4 should complete
    resolvers[1]?.();
    await task2;
    await task4Promise;

    assert.strictEqual(limiter.getStats().queueDepth, 0);
  });

  test("backpressure path: sheds poll tasks when queue depth exceeds maxQueueDepth", async () => {
    const limiter = new ArenaPollConcurrencyLimiter({ maxConcurrency: 1, maxQueueDepth: 2 });

    let resolveWorker!: () => void;
    const workerPromise = new Promise<void>((res) => {
      resolveWorker = res;
    });

    // Occupy single worker slot
    const task1 = limiter.executeBounded("arena-1", () => workerPromise);

    // Queue 2 tasks (maxQueueDepth = 2)
    const task2 = limiter.executeBounded("arena-2", async () => {});
    const task3 = limiter.executeBounded("arena-3", async () => {});

    assert.strictEqual(limiter.getStats().queueDepth, 2);

    // 4th task exceeds queue depth -> shed via backpressure
    const task4Result = await limiter.executeBounded("arena-4", async () => {
      assert.fail("Shed task should not run");
    });

    assert.strictEqual(task4Result, false);
    assert.strictEqual(limiter.getExecutionState("arena-4"), "BACKOFF");
    assert.strictEqual(limiter.getStats().totalShed, 1);

    // Clean up worker
    resolveWorker();
    await task1;
    await task2;
    await task3;
  });

  test("retry & failure path: records state transition to BACKOFF on error", async () => {
    const limiter = new ArenaPollConcurrencyLimiter({ maxConcurrency: 5, maxQueueDepth: 10 });

    try {
      await limiter.executeBounded("arena-error", async () => {
        throw new Error("RPC timeout failure");
      });
      assert.fail("Expected error was not thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.strictEqual(err.message, "RPC timeout failure");
    }

    assert.strictEqual(limiter.getExecutionState("arena-error"), "BACKOFF");
    assert.strictEqual(limiter.getStats().activePolls, 0);
  });

  test("configuration bounds & stats update", () => {
    setPollerConcurrencyConfig({ maxConcurrency: 15, maxQueueDepth: 35, pollTimeoutMs: 5000 });
    const stats = getPollerConcurrencyStats();

    assert.strictEqual(stats.maxConcurrency, 15);
    assert.strictEqual(stats.maxQueueDepth, 35);
  });
});
