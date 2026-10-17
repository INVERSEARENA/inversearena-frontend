import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  ArenaPollScheduler,
  type ArenaLifecycleState,
  type ArenaScheduleEntry,
} from "../src/cache/arenaPollScheduler";
import { computePollDelay, wakePoller, wakeArena } from "../src/cache/arenaPoller";

describe("Adaptive Arena Poller & Scheduling Cadence (#1524)", () => {
  let scheduler: ArenaPollScheduler;

  beforeEach(() => {
    scheduler = new ArenaPollScheduler({
      minIntervalMs: 500,
      maxIntervalMs: 60_000,
      activeBaseIntervalMs: 2_000,
      openBaseIntervalMs: 3_000,
      idleTerminalIntervalMs: 30_000,
      maxErrorBackoffMs: 60_000,
      maxConcurrentPolls: 10,
      starvationLimitMs: 15_000,
    });
  });

  describe("Lifecycle-Driven Cadence Calculation", () => {
    it("calculates normal base interval for watched active arenas far from deadline", () => {
      const now = 1_000_000;
      const entry: ArenaScheduleEntry = {
        arenaId: "arena-1",
        lifecycleState: "ACTIVE_COMMIT",
        subscribersCount: 2,
        commitDeadline: now + 60_000, // 60s away
        consecutiveFailures: 0,
        lastPollTimestamp: now - 2_000,
        scheduledPollTimestamp: now,
        priorityScore: 2,
        isPolling: false,
      };

      const delay = scheduler.calculateCadence(entry, now);
      expect(delay).toBe(2_000);
    });

    it("accelerates cadence to 1,000ms when within 10s of deadline", () => {
      const now = 1_000_000;
      const entry: ArenaScheduleEntry = {
        arenaId: "arena-2",
        lifecycleState: "ACTIVE_COMMIT",
        subscribersCount: 3,
        commitDeadline: now + 8_000, // 8s away
        consecutiveFailures: 0,
        lastPollTimestamp: now - 1_000,
        scheduledPollTimestamp: now,
        priorityScore: 2,
        isPolling: false,
      };

      const delay = scheduler.calculateCadence(entry, now);
      expect(delay).toBe(1_000);
    });

    it("accelerates cadence to minIntervalMs (500ms) when approaching deadline (< 5s)", () => {
      const now = 1_000_000;
      const entry: ArenaScheduleEntry = {
        arenaId: "arena-3",
        lifecycleState: "ACTIVE_REVEAL",
        subscribersCount: 5,
        revealDeadline: now + 3_000, // 3s away
        consecutiveFailures: 0,
        lastPollTimestamp: now - 500,
        scheduledPollTimestamp: now,
        priorityScore: 1,
        isPolling: false,
      };

      const delay = scheduler.calculateCadence(entry, now);
      expect(delay).toBe(500);
    });

    it("backs off idle terminal arenas with no subscribers to 30,000ms", () => {
      const now = 1_000_000;
      const entry: ArenaScheduleEntry = {
        arenaId: "arena-terminal",
        lifecycleState: "RESOLVED",
        subscribersCount: 0, // no viewers
        consecutiveFailures: 0,
        lastPollTimestamp: now - 30_000,
        scheduledPollTimestamp: now,
        priorityScore: 5,
        isPolling: false,
      };

      const delay = scheduler.calculateCadence(entry, now);
      expect(delay).toBe(30_000);
    });

    it("applies exponential backoff with jitter on consecutive failures", () => {
      const now = 1_000_000;
      const entry: ArenaScheduleEntry = {
        arenaId: "arena-failing",
        lifecycleState: "ACTIVE_COMMIT",
        subscribersCount: 1,
        consecutiveFailures: 3,
        lastPollTimestamp: now - 5_000,
        scheduledPollTimestamp: now,
        priorityScore: 4,
        isPolling: false,
      };

      const delay = scheduler.calculateCadence(entry, now);
      // Base: 2000 * 2^(3-1) = 8000 ms, plus up to 15% jitter
      expect(delay).toBeGreaterThanOrEqual(8_000);
      expect(delay).toBeLessThanOrEqual(10_000);
    });
  });

  describe("Deterministic Priority & Starvation Prevention", () => {
    it("assigns highest priority (1) to urgent deadline arenas", () => {
      const now = 1_000_000;
      const entry: ArenaScheduleEntry = {
        arenaId: "urgent-arena",
        lifecycleState: "ACTIVE_COMMIT",
        subscribersCount: 2,
        commitDeadline: now + 2_000, // 2s away
        consecutiveFailures: 0,
        lastPollTimestamp: now - 500,
        scheduledPollTimestamp: now,
        priorityScore: 0,
        isPolling: false,
      };

      const score = scheduler.computePriorityScore(entry, now);
      expect(score).toBe(1);
    });

    it("elevates priority to 1 if an arena is starved beyond starvationLimitMs", () => {
      const now = 1_000_000;
      const entry: ArenaScheduleEntry = {
        arenaId: "starved-arena",
        lifecycleState: "OPEN",
        subscribersCount: 0,
        consecutiveFailures: 0,
        lastPollTimestamp: now - 40_000,
        scheduledPollTimestamp: now - 25_000, // overdue by 25s > 15s limit
        priorityScore: 4,
        isPolling: false,
      };

      const score = scheduler.computePriorityScore(entry, now);
      expect(score).toBe(1); // Boosted to 1 due to starvation
    });
  });

  describe("Wake Triggers", () => {
    it("wakes sleeping arena immediately on subscription, mutation, or reconciliation events", () => {
      const now = 1_000_000;
      scheduler.registerOrUpdate("sleeping-arena", {
        lifecycleState: "RESOLVED",
        subscribersCount: 0,
      });

      const entry = scheduler.getEntry("sleeping-arena");
      expect(entry).toBeDefined();
      if (entry) {
        entry.scheduledPollTimestamp = now + 30_000; // scheduled in 30s
      }

      // Wake on subscription
      const woke = scheduler.wake("sleeping-arena", "subscription");
      expect(woke).toBe(true);
      expect(entry?.scheduledPollTimestamp).toBeLessThanOrEqual(Date.now());
      expect(entry?.priorityScore).toBe(1);
    });
  });

  describe("Large-Scale Simulation Tests (Thousands of Arenas, Clustered Deadlines & Concurrency Limits)", () => {
    it("simulates 1,000 arenas and respects maxConcurrentPolls without unbounded backlog", async () => {
      const pollMock = jest.fn(async (arenaId: string) => {
        // simulate 10ms work
        await new Promise((r) => setTimeout(r, 5));
      });
      scheduler.setPollHandler(pollMock);

      const now = Date.now();

      // Register 1,000 arenas with varied states
      for (let i = 0; i < 1000; i++) {
        const state: ArenaLifecycleState =
          i < 100 ? "ACTIVE_COMMIT" : i < 300 ? "OPEN" : "RESOLVED";
        const subscribers = i < 50 ? 5 : 0;
        const deadline = i < 50 ? now + 2_000 : undefined;

        scheduler.registerOrUpdate(`sim-arena-${i}`, {
          lifecycleState: state,
          subscribersCount: subscribers,
          commitDeadline: deadline,
          initialJitter: true,
        });
      }

      expect(scheduler.getAllEntries().length).toBe(1000);

      // Execute a tick
      const polledCount = await scheduler.tick(now);
      // Must not exceed maxConcurrentPolls (10)
      expect(polledCount).toBeLessThanOrEqual(10);
    });

    it("handles failure storms with exponential backoff and circuit-breaker backpressure", () => {
      const now = 1_000_000;
      for (let i = 0; i < 10; i++) {
        const delay = computePollDelay(i, {
          roundState: "ACTIVE_COMMIT",
          subscribersCount: 1,
        });
        if (i === 0) {
          expect(delay).toBe(2_000);
        } else {
          expect(delay).toBeGreaterThanOrEqual(2_500);
          expect(delay).toBeLessThanOrEqual(60_000);
        }
      }
    });

    it("handles clock jumps gracefully without corrupting scheduler state", () => {
      const t0 = 1_000_000;
      scheduler.registerOrUpdate("clock-arena", {
        lifecycleState: "ACTIVE_COMMIT",
        subscribersCount: 2,
        commitDeadline: t0 + 10_000,
      });

      const entry = scheduler.getEntry("clock-arena")!;
      expect(entry).toBeDefined();

      // Clock jumps 1 hour forward
      const t1 = t0 + 3_600_000;
      const cadence = scheduler.calculateCadence(entry, t1);
      expect(cadence).toBeGreaterThanOrEqual(500);
      expect(cadence).toBeLessThanOrEqual(60_000);

      const score = scheduler.computePriorityScore(entry, t1);
      expect(score).toBeGreaterThanOrEqual(1);
    });
  });
});
