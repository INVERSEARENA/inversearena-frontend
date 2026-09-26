import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import {
  subscribeArena,
  resetPollersForTest,
  setPollerConcurrencyConfig,
  getPollerConcurrencyStats,
} from "../src/cache/arenaPoller";
import {
  arenaPollerActivePollsGauge,
  arenaPollerQueueDepthGauge,
  arenaPollerBackpressureShedTotal,
} from "../src/utils/metrics";
import type { ArenaService } from "../src/services/arenaService";

describe("Arena Poller Integration Test: Cross-Module Flow (#1433)", () => {
  beforeEach(() => {
    resetPollersForTest();
  });

  test("subscribeArena integrates with bounded concurrency limiter and emits SSE events", async () => {
    setPollerConcurrencyConfig({ maxConcurrency: 2, maxQueueDepth: 5 });

    const arenaId = `arena-integration-${Date.now()}`;
    let getSnapshotCalls = 0;
    const mockArenaSnapshot = {
      arenaId,
      currentRound: 1,
      playerCount: 10,
      survivorCount: 8,
      status: "active",
      lastRoundState: "ACTIVE_COMMIT",
      recentEliminations: [],
    };

    const mockArenaService = {
      getSnapshot: async (id: string) => {
        getSnapshotCalls += 1;
        assert.strictEqual(id, arenaId);
        return mockArenaSnapshot;
      },
    } as unknown as ArenaService;

    const receivedEvents: Array<{ event: string; payload: unknown }> = [];
    const receivedSnapshots: Array<unknown> = [];

    const subscriber = {
      sendEvent: (event: string, payload: unknown) => {
        receivedEvents.push({ event, payload });
      },
      sendSnapshot: (data: unknown) => {
        receivedSnapshots.push(data);
      },
    };

    const unsubscribe = subscribeArena(arenaId, subscriber, mockArenaService);

    // Give asynchronous poll loop time to execute bounded snapshot fetch
    await new Promise((resolve) => setTimeout(resolve, 150));

    try {
      assert.ok(getSnapshotCalls >= 1, `getSnapshot should be called by poller, actual calls: ${getSnapshotCalls}`);
      assert.ok(receivedSnapshots.length >= 1, `Snapshot should be fanned out to subscriber, actual snapshots: ${receivedSnapshots.length}`);
      const stats = getPollerConcurrencyStats();
      assert.strictEqual(stats.activePolls, 0, "Poller active count should return to 0 when idle");
    } catch (err) {
      console.error("Integration test assertion failed:", err);
      throw err;
    } finally {
      unsubscribe();
      resetPollersForTest();
    }
  });
});
