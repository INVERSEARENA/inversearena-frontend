import { test, describe } from "node:test";
import assert from "node:assert";
import { ArenaPollConcurrencyLimiter } from "../src/cache/arenaPoller";

describe("Arena Poller Load Test: Bounded Concurrency During RPC Slowdown (#1433)", () => {
  test("proves request concurrency stays bounded during RPC slowdown", async () => {
    // Configure tight bounds for high load verification:
    // Max 5 concurrent RPC calls in flight, max queue depth 10
    const maxConcurrency = 5;
    const maxQueueDepth = 10;
    const limiter = new ArenaPollConcurrencyLimiter({
      maxConcurrency,
      maxQueueDepth,
      pollTimeoutMs: 5000,
    });

    let activeRpcCount = 0;
    let maxObservedRpcConcurrency = 0;
    let completedPolls = 0;
    let shedPolls = 0;

    const rpcDelayMs = 100; // Simulated Soroban RPC slowdown per poll

    // Simulate 30 simultaneous arena poll requests firing concurrently
    const totalRequests = 30;
    const pollPromises: Array<Promise<boolean>> = [];

    for (let i = 0; i < totalRequests; i++) {
      const arenaId = `arena-load-${i}`;
      const promise = limiter.executeBounded(arenaId, async () => {
        activeRpcCount += 1;
        if (activeRpcCount > maxObservedRpcConcurrency) {
          maxObservedRpcConcurrency = activeRpcCount;
        }

        // Assert at runtime that active RPC calls NEVER exceed maxConcurrency
        assert.ok(
          activeRpcCount <= maxConcurrency,
          `Active RPC concurrency (${activeRpcCount}) exceeded maxConcurrency (${maxConcurrency})`,
        );

        // Simulate RPC slowdown delay
        await new Promise((resolve) => setTimeout(resolve, rpcDelayMs));

        activeRpcCount -= 1;
        completedPolls += 1;
      });

      pollPromises.push(promise);
    }

    const results = await Promise.all(pollPromises);

    for (const res of results) {
      if (!res) {
        shedPolls += 1;
      }
    }

    const stats = limiter.getStats();

    // Verification assertions:
    // 1. Max active RPC concurrency NEVER exceeded maxConcurrency (5)
    assert.strictEqual(
      maxObservedRpcConcurrency,
      maxConcurrency,
      `Max observed RPC concurrency should reach capped limit of ${maxConcurrency}`,
    );

    // 2. Queue depth was respected and backpressure shed excess requests beyond maxQueueDepth
    const expectedMaxProcessed = maxConcurrency + maxQueueDepth; // 5 + 10 = 15 max allowed
    assert.strictEqual(completedPolls, expectedMaxProcessed);
    assert.strictEqual(shedPolls, totalRequests - expectedMaxProcessed); // 30 - 15 = 15 shed
    assert.strictEqual(stats.totalShed, 15);
    assert.strictEqual(stats.activePolls, 0);
    assert.strictEqual(stats.queueDepth, 0);
  });
});
