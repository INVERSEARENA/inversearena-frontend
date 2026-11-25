import {
  arenaPollerCadenceSeconds,
  arenaPollerWakeTotal,
  arenaPollerLatenessMs,
  arenaPollerSkippedTotal,
  arenaPollerActiveArenasGauge,
} from "../utils/metrics";
import { logger } from "../utils/logger";

export type ArenaLifecycleState =
  | "OPEN"
  | "ACTIVE_COMMIT"
  | "ACTIVE_REVEAL"
  | "RESOLVED"
  | "SETTLED"
  | "DEGRADED";

export type WakeReason =
  | "subscription"
  | "mutation"
  | "reconciliation"
  | "manual";

export interface ArenaScheduleEntry {
  arenaId: string;
  lifecycleState: ArenaLifecycleState;
  subscribersCount: number;
  commitDeadline?: number | undefined;
  revealDeadline?: number | undefined;
  consecutiveFailures: number;
  lastPollTimestamp: number;
  scheduledPollTimestamp: number;
  priorityScore: number;
  isPolling: boolean;
}

export interface PollerSchedulerOptions {
  minIntervalMs?: number | undefined;
  maxIntervalMs?: number | undefined;
  activeBaseIntervalMs?: number | undefined;
  openBaseIntervalMs?: number | undefined;
  idleTerminalIntervalMs?: number | undefined;
  maxErrorBackoffMs?: number | undefined;
  maxConcurrentPolls?: number | undefined;
  starvationLimitMs?: number | undefined;
  jitterRatio?: number | undefined;
}

export class ArenaPollScheduler {
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly activeBaseIntervalMs: number;
  private readonly openBaseIntervalMs: number;
  private readonly idleTerminalIntervalMs: number;
  private readonly maxErrorBackoffMs: number;
  private readonly maxConcurrentPolls: number;
  private readonly starvationLimitMs: number;
  private readonly jitterRatio: number;

  private entries = new Map<string, ArenaScheduleEntry>();
  private activePolls = 0;
  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private pollHandler?: ((arenaId: string) => Promise<void>) | undefined;

  constructor(options: PollerSchedulerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.maxIntervalMs = options.maxIntervalMs ?? 60_000;
    this.activeBaseIntervalMs = options.activeBaseIntervalMs ?? 2_000;
    this.openBaseIntervalMs = options.openBaseIntervalMs ?? 3_000;
    this.idleTerminalIntervalMs = options.idleTerminalIntervalMs ?? 30_000;
    this.maxErrorBackoffMs = options.maxErrorBackoffMs ?? 60_000;
    this.maxConcurrentPolls = options.maxConcurrentPolls ?? 25;
    this.starvationLimitMs = options.starvationLimitMs ?? 20_000;
    this.jitterRatio = options.jitterRatio ?? 0.15;
  }

  setPollHandler(handler: (arenaId: string) => Promise<void>): void {
    this.pollHandler = handler;
  }

  registerOrUpdate(
    arenaId: string,
    params: {
      lifecycleState?: ArenaLifecycleState | undefined;
      subscribersCount?: number | undefined;
      commitDeadline?: number | undefined;
      revealDeadline?: number | undefined;
      consecutiveFailures?: number | undefined;
      initialJitter?: boolean | undefined;
    } = {},
  ): ArenaScheduleEntry {
    let entry = this.entries.get(arenaId);
    const now = Date.now();

    if (!entry) {
      const initialDelay = params.initialJitter
        ? Math.floor(Math.random() * 2_500)
        : 0;

      entry = {
        arenaId,
        lifecycleState: params.lifecycleState ?? "OPEN",
        subscribersCount: params.subscribersCount ?? 0,
        commitDeadline: params.commitDeadline,
        revealDeadline: params.revealDeadline,
        consecutiveFailures: params.consecutiveFailures ?? 0,
        lastPollTimestamp: 0,
        scheduledPollTimestamp: now + initialDelay,
        priorityScore: 3,
        isPolling: false,
      };
      this.entries.set(arenaId, entry);
    } else {
      if (params.lifecycleState !== undefined) entry.lifecycleState = params.lifecycleState;
      if (params.subscribersCount !== undefined) entry.subscribersCount = params.subscribersCount;
      if (params.commitDeadline !== undefined) entry.commitDeadline = params.commitDeadline;
      if (params.revealDeadline !== undefined) entry.revealDeadline = params.revealDeadline;
      if (params.consecutiveFailures !== undefined) entry.consecutiveFailures = params.consecutiveFailures;
    }

    this.updatePriorityAndCadence(entry, now);
    this.updateMetrics();
    return entry;
  }

  unregister(arenaId: string): void {
    this.entries.delete(arenaId);
    this.updateMetrics();
  }

  getEntry(arenaId: string): ArenaScheduleEntry | undefined {
    return this.entries.get(arenaId);
  }

  getAllEntries(): ArenaScheduleEntry[] {
    return Array.from(this.entries.values());
  }

  wake(arenaId: string, reason: WakeReason): boolean {
    const entry = this.entries.get(arenaId);
    if (!entry) return false;

    const now = Date.now();
    entry.scheduledPollTimestamp = now;
    entry.priorityScore = 1; // Boost to top priority on wake
    arenaPollerWakeTotal.inc({ reason });
    logger.info({ event: "arena_poller_wake", arenaId, reason }, "Arena poller awakened");
    return true;
  }

  calculateCadence(entry: ArenaScheduleEntry, now = Date.now()): number {
    // 1. Degraded / Failure backoff
    if (entry.consecutiveFailures > 0) {
      const base = Math.min(
        this.maxErrorBackoffMs,
        this.activeBaseIntervalMs * Math.pow(2, entry.consecutiveFailures - 1),
      );
      const jitter = Math.floor(Math.random() * (base * this.jitterRatio));
      return Math.min(this.maxErrorBackoffMs, base + jitter);
    }

    const isWatched = entry.subscribersCount > 0;
    const isTerminal = entry.lifecycleState === "RESOLVED" || entry.lifecycleState === "SETTLED";
    const isActive = entry.lifecycleState === "ACTIVE_COMMIT" || entry.lifecycleState === "ACTIVE_REVEAL";

    // 2. Terminal Arenas
    if (isTerminal) {
      if (isWatched) {
        return 10_000;
      }
      return this.idleTerminalIntervalMs;
    }

    // 3. Active Rounds with Deadlines
    if (isActive) {
      const relevantDeadline =
        entry.lifecycleState === "ACTIVE_COMMIT"
          ? entry.commitDeadline
          : entry.revealDeadline;

      if (relevantDeadline && relevantDeadline > now) {
        const timeToDeadline = relevantDeadline - now;
        if (timeToDeadline <= 5_000) {
          // Approaching deadline < 5s -> max acceleration
          return this.minIntervalMs;
        } else if (timeToDeadline <= 10_000) {
          return 1_000;
        }
      }

      return isWatched ? this.activeBaseIntervalMs : 5_000;
    }

    // 4. Open Lobby
    if (entry.lifecycleState === "OPEN") {
      return isWatched ? this.openBaseIntervalMs : 10_000;
    }

    return this.activeBaseIntervalMs;
  }

  computePriorityScore(entry: ArenaScheduleEntry, now = Date.now()): number {
    // Check for starvation
    const waitTime = now - entry.scheduledPollTimestamp;
    if (waitTime > this.starvationLimitMs) {
      return 1; // Elevated priority to prevent starvation
    }

    if (entry.consecutiveFailures > 0) {
      return 4; // Degraded
    }

    const isWatched = entry.subscribersCount > 0;
    const isActive = entry.lifecycleState === "ACTIVE_COMMIT" || entry.lifecycleState === "ACTIVE_REVEAL";
    const isTerminal = entry.lifecycleState === "RESOLVED" || entry.lifecycleState === "SETTLED";

    if (isActive) {
      const relevantDeadline =
        entry.lifecycleState === "ACTIVE_COMMIT"
          ? entry.commitDeadline
          : entry.revealDeadline;

      if (relevantDeadline && relevantDeadline - now <= 5_000) {
        return 1; // Urgent deadline
      }
      return isWatched ? 2 : 3;
    }

    if (entry.lifecycleState === "OPEN") {
      return isWatched ? 3 : 4;
    }

    if (isTerminal) {
      return isWatched ? 4 : 5;
    }

    return 3;
  }

  private updatePriorityAndCadence(entry: ArenaScheduleEntry, now = Date.now()): void {
    entry.priorityScore = this.computePriorityScore(entry, now);
    const cadence = this.calculateCadence(entry, now);
    arenaPollerCadenceSeconds.observe(
      { state: entry.lifecycleState },
      cadence / 1000,
    );
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextTick();
  }

  stop(): void {
    this.isRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  private scheduleNextTick(): void {
    if (!this.isRunning) return;
    this.loopTimer = setTimeout(() => {
      void this.tick();
    }, 250);
  }

  async tick(now = Date.now()): Promise<number> {
    if (this.activePolls >= this.maxConcurrentPolls) {
      arenaPollerSkippedTotal.inc({ reason: "concurrency_limit" });
      this.scheduleNextTick();
      return 0;
    }

    // Find arenas due for polling
    const dueEntries = Array.from(this.entries.values())
      .filter((entry) => !entry.isPolling && entry.scheduledPollTimestamp <= now)
      .sort((a, b) => {
        // Priority first (lower score = higher priority)
        if (a.priorityScore !== b.priorityScore) {
          return a.priorityScore - b.priorityScore;
        }
        // Then oldest scheduled timestamp
        return a.scheduledPollTimestamp - b.scheduledPollTimestamp;
      });

    const slotsAvailable = this.maxConcurrentPolls - this.activePolls;
    const toPoll = dueEntries.slice(0, slotsAvailable);

    for (const entry of toPoll) {
      const latenessMs = Math.max(0, now - entry.scheduledPollTimestamp);
      arenaPollerLatenessMs.observe(latenessMs);

      entry.isPolling = true;
      this.activePolls += 1;

      // Run poll asynchronously
      void this.executePoll(entry);
    }

    this.scheduleNextTick();
    return toPoll.length;
  }

  private async executePoll(entry: ArenaScheduleEntry): Promise<void> {
    const started = Date.now();
    try {
      if (this.pollHandler) {
        await this.pollHandler(entry.arenaId);
      }
      entry.consecutiveFailures = 0;
      entry.lastPollTimestamp = started;
    } catch (err) {
      entry.consecutiveFailures += 1;
      logger.error(
        { arenaId: entry.arenaId, err, failures: entry.consecutiveFailures },
        "Arena poll execution error in scheduler",
      );
    } finally {
      entry.isPolling = false;
      this.activePolls = Math.max(0, this.activePolls - 1);

      const now = Date.now();
      const delay = this.calculateCadence(entry, now);
      entry.scheduledPollTimestamp = now + delay;
      entry.priorityScore = this.computePriorityScore(entry, now);
    }
  }

  private updateMetrics(): void {
    const counts: Record<ArenaLifecycleState, number> = {
      OPEN: 0,
      ACTIVE_COMMIT: 0,
      ACTIVE_REVEAL: 0,
      RESOLVED: 0,
      SETTLED: 0,
      DEGRADED: 0,
    };

    for (const entry of this.entries.values()) {
      if (counts[entry.lifecycleState] !== undefined) {
        counts[entry.lifecycleState]++;
      }
    }

    for (const [state, count] of Object.entries(counts)) {
      arenaPollerActiveArenasGauge.set({ lifecycle_state: state }, count);
    }
  }
}

export const arenaPollScheduler = new ArenaPollScheduler();
