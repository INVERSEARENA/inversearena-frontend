/**
 * Shared arena SSE poller with fan-out.
 *
 * Instead of each SSE client running its own DB poll loop (N clients = N queries
 * per interval), a single background poller per arena fetches the snapshot and
 * fans it out to all connected subscribers. This keeps DB load constant at
 * 1 query per arena per poll interval, regardless of spectator count.
 *
 * Publication is semantically versioned (#1500): each poll runs through
 * arenaPollPipeline, and only a poll whose canonical fingerprint changed
 * persists the full snapshot and fans out an updated `snapshot` envelope
 * carrying a monotonic `version`, its `previousVersion`, and the per-process
 * `instanceId`. Unchanged polls refresh heartbeat metadata only — no cache
 * rewrite of the snapshot, no stream traffic.
 */

import { randomUUID } from "crypto";
import type { ArenaService } from "../services/arenaService";
import { getSorobanBreaker } from "../utils/circuitBreaker";
import { refreshLedgerIdentity } from "../services/ledgerClock";
import { getRollbackGuard } from "../services/ledgerContinuity";
import {
  arenaPollsTotal,
  arenaSuppressedPublishesTotal,
  arenaSemanticChangesTotal,
  arenaPollerActivePollsGauge,
  arenaPollerQueueDepthGauge,
  arenaPollerBackpressureShedTotal,
  arenaPollerPollDurationSeconds,
  arenaPollerRetriesTotal,
  arenaPollerSkippedTotal,
} from "../utils/metrics";
import {
  createArenaPollStages,
  runArenaPollStages,
  type ArenaSnapshot,
  type ArenaSnapshotMeta,
} from "./arenaPollPipeline";
import {
  arenaPollScheduler,
  type ArenaLifecycleState,
  type WakeReason,
} from "./arenaPollScheduler";

export type PollerExecutionState = "IDLE" | "QUEUED" | "POLLING" | "BACKOFF";

export interface PollerConcurrencyConfig {
  /** Maximum concurrent in-flight arena poll operations across all arenas. */
  maxConcurrency: number;
  /** Maximum queued poll requests allowed before applying backpressure shedding. */
  maxQueueDepth: number;
  /** Timeout for individual poll operation in milliseconds. */
  pollTimeoutMs: number;
}

export interface PollerConcurrencyStats {
  activePolls: number;
  queueDepth: number;
  maxConcurrency: number;
  maxQueueDepth: number;
  totalShed: number;
  totalProcessed: number;
}

interface QueuedPollTask {
  arenaId: string;
  pollFn: () => Promise<void>;
  resolve: (executed: boolean) => void;
  reject: (err: unknown) => void;
  queuedAt: number;
}

export class ArenaPollConcurrencyLimiter {
  private config: PollerConcurrencyConfig;
  private activePolls = 0;
  private queue: QueuedPollTask[] = [];
  private executionStates = new Map<string, PollerExecutionState>();
  private totalShed = 0;
  private totalProcessed = 0;

  constructor(config: Partial<PollerConcurrencyConfig> = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 20,
      maxQueueDepth: config.maxQueueDepth ?? 50,
      pollTimeoutMs: config.pollTimeoutMs ?? 10_000,
    };
  }

  public updateConfig(config: Partial<PollerConcurrencyConfig>): void {
    if (config.maxConcurrency !== undefined && config.maxConcurrency > 0) {
      this.config.maxConcurrency = config.maxConcurrency;
    }
    if (config.maxQueueDepth !== undefined && config.maxQueueDepth >= 0) {
      this.config.maxQueueDepth = config.maxQueueDepth;
    }
    if (config.pollTimeoutMs !== undefined && config.pollTimeoutMs > 0) {
      this.config.pollTimeoutMs = config.pollTimeoutMs;
    }
  }

  public getConfig(): Readonly<PollerConcurrencyConfig> {
    return { ...this.config };
  }

  public getExecutionState(arenaId: string): PollerExecutionState {
    return this.executionStates.get(arenaId) ?? "IDLE";
  }

  public getStats(): PollerConcurrencyStats {
    return {
      activePolls: this.activePolls,
      queueDepth: this.queue.length,
      maxConcurrency: this.config.maxConcurrency,
      maxQueueDepth: this.config.maxQueueDepth,
      totalShed: this.totalShed,
      totalProcessed: this.totalProcessed,
    };
  }

  public resetForTest(): void {
    this.activePolls = 0;
    this.queue = [];
    this.executionStates.clear();
    this.totalShed = 0;
    this.totalProcessed = 0;
    arenaPollerActivePollsGauge.set(0);
    arenaPollerQueueDepthGauge.set(0);
  }

  public async executeBounded(
    arenaId: string,
    pollFn: () => Promise<void>,
  ): Promise<boolean> {
    const currentState = this.getExecutionState(arenaId);

    // Single-flight deduplication: if already polling or queued, skip duplicate trigger
    if (currentState === "POLLING" || currentState === "QUEUED") {
      return false;
    }

    if (this.activePolls < this.config.maxConcurrency) {
      return this.runTask(arenaId, pollFn);
    }

    // Active limit reached -> check backpressure queue capacity
    if (this.queue.length >= this.config.maxQueueDepth) {
      this.totalShed += 1;
      this.executionStates.set(arenaId, "BACKOFF");
      arenaPollerBackpressureShedTotal.inc({ reason: "queue_full" });
      arenaPollerSkippedTotal.inc({ reason: "backpressure" });
      console.warn(
        JSON.stringify({
          event: "arena_poller_backpressure_shed",
          arenaId,
          activePolls: this.activePolls,
          queueDepth: this.queue.length,
          maxQueueDepth: this.config.maxQueueDepth,
        }),
      );
      return false;
    }

    // Queue task under backpressure
    this.executionStates.set(arenaId, "QUEUED");
    return new Promise<boolean>((resolve, reject) => {
      this.queue.push({
        arenaId,
        pollFn,
        resolve,
        reject,
        queuedAt: Date.now(),
      });
      arenaPollerQueueDepthGauge.set(this.queue.length);
    });
  }

  private async runTask(
    arenaId: string,
    pollFn: () => Promise<void>,
  ): Promise<boolean> {
    this.activePolls += 1;
    this.executionStates.set(arenaId, "POLLING");
    arenaPollerActivePollsGauge.set(this.activePolls);
    const startHighRes = process.hrtime.bigint();

    let outcome: "ok" | "error" = "ok";
    try {
      await this.withTimeout(pollFn(), this.config.pollTimeoutMs, arenaId);
      this.totalProcessed += 1;
      this.executionStates.set(arenaId, "IDLE");
      return true;
    } catch (err) {
      outcome = "error";
      this.executionStates.set(arenaId, "BACKOFF");
      throw err;
    } finally {
      const elapsedNs = process.hrtime.bigint() - startHighRes;
      const durationSec = Number(elapsedNs) / 1_000_000_000;
      arenaPollerPollDurationSeconds.observe({ outcome }, durationSec);

      this.activePolls = Math.max(0, this.activePolls - 1);
      arenaPollerActivePollsGauge.set(this.activePolls);

      this.processNext();
    }
  }

  private processNext(): void {
    if (this.queue.length === 0 || this.activePolls >= this.config.maxConcurrency) {
      return;
    }

    const nextTask = this.queue.shift();
    arenaPollerQueueDepthGauge.set(this.queue.length);

    if (nextTask) {
      this.runTask(nextTask.arenaId, nextTask.pollFn)
        .then(nextTask.resolve)
        .catch(nextTask.reject);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    arenaId: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Arena poll execution timed out after ${timeoutMs}ms for arena ${arenaId}`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const pollerConcurrencyLimiter = new ArenaPollConcurrencyLimiter();

export function setPollerConcurrencyConfig(
  config: Partial<PollerConcurrencyConfig>,
): void {
  pollerConcurrencyLimiter.updateConfig(config);
}

export function getPollerConcurrencyStats(): PollerConcurrencyStats {
  return pollerConcurrencyLimiter.getStats();
}

export function resetPollerConcurrencyLimiterForTest(): void {
  pollerConcurrencyLimiter.resetForTest();
}

interface Subscriber {
  /** Send an SSE event to this client. */
  sendEvent: (event: string, payload: unknown, id?: number) => void;
  /** Send raw SSE data (for snapshots). */
  sendSnapshot: (data: unknown, id?: number) => void;
  /** Called when the subscriber disconnects or the arena is cleaned up. */
  onCleanup?: () => void;
}

interface ArenaPollerState {
  instanceId?: string | undefined;
  subscribers: Set<Subscriber>;
  pollTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  /** Last known state for change detection. */
  lastRoundState: string | null;
  lastStatus: string | null;
  lastSurvivorCount: number | null;
  seenEliminations: Set<string>;
  sequence: number;
  history: Array<{ event: string; payload: unknown; sequence: number }>;
  lastSnapshot: { payload: unknown; sequence: number } | null;
  consecutiveFailures: number;
  /** Rollback epoch this poller last published under (#1490). */
  rollbackEpoch: number;
  snapshotMeta?: ArenaSnapshotMeta | undefined;
  commitDeadline?: number | undefined;
  revealDeadline?: number | undefined;
  pollNow?: (() => void) | undefined;
}

const pollers = new Map<string, ArenaPollerState>();

const POLL_INTERVAL_MS = 2_500;
const POLL_RETRY_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HISTORY_LIMIT = 512;

export function computePollDelay(
  consecutiveFailures: number,
  state?: {
    roundState?: string | null | undefined;
    subscribersCount?: number | undefined;
    commitDeadline?: number | undefined;
    revealDeadline?: number | undefined;
  } | undefined,
  now = Date.now(),
): number {
  if (consecutiveFailures > 0) {
    const base = Math.min(POLL_RETRY_MAX_MS, POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1));
    const jitter = Math.floor(Math.random() * (base * 0.15));
    return Math.min(POLL_RETRY_MAX_MS, base + jitter);
  }

  if (state) {
    const roundState = state.roundState ?? "OPEN";
    const subscribers = state.subscribersCount ?? 0;

    if (roundState === "RESOLVED" || roundState === "SETTLED") {
      return subscribers > 0 ? 10_000 : 30_000;
    }

    if (roundState === "ACTIVE_COMMIT" || roundState === "ACTIVE_REVEAL" || roundState === "OPEN") {
      const deadline = state.commitDeadline ?? state.revealDeadline;
      if (deadline && deadline > now) {
        const remaining = deadline - now;
        if (remaining <= 5_000) return 500;
        if (remaining <= 10_000) return 1_000;
      }
      return subscribers > 0 ? 2_000 : 5_000;
    }
  }

  return POLL_INTERVAL_MS;
}

export function wakePoller(
  arenaId: string,
  reason: WakeReason = "manual",
): boolean {
  arenaPollScheduler.wake(arenaId, reason);
  const state = pollers.get(arenaId);
  if (state && state.pollNow) {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollNow();
    return true;
  }
  return false;
}

export function wakeArena(arenaId: string, reason: WakeReason = "manual"): boolean {
  return wakePoller(arenaId, reason);
}


/**
 * Reconnect plan for a client resuming with `afterSequence` (#1500).
 *
 * - no cursor → send the latest full snapshot;
 * - cursor equal to the current sequence → nothing to replay;
 * - cursor covered by the bounded history → replay the missed events in order;
 * - stale cursor (fell out of history) → fall back to the latest full snapshot
 *   so a client that missed several versions recovers instead of stalling.
 */
export function planReplay(
  lastSnapshot: { payload: unknown; sequence: number } | null,
  history: Array<{ event: string; payload: unknown; sequence: number }>,
  currentSequence: number,
  afterSequence: number | undefined,
): { kind: "snapshot"; payload: unknown; sequence: number } | { kind: "replay"; items: Array<{ event: string; payload: unknown; sequence: number }> } | { kind: "none" } {
  if (!lastSnapshot) return { kind: "none" };
  if (afterSequence === undefined) {
    return { kind: "snapshot", payload: lastSnapshot.payload, sequence: lastSnapshot.sequence };
  }
  const items = history.filter((item) => item.sequence > afterSequence);
  if (items.length > 0) return { kind: "replay", items };
  if (afterSequence !== currentSequence) {
    return { kind: "snapshot", payload: lastSnapshot.payload, sequence: lastSnapshot.sequence };
  }
  return { kind: "none" };
}

/**
 * Start the shared poller for an arena (if not already running) and add a subscriber.
 * Returns an unsubscribe function.
 */
export function subscribeArena(
  arenaId: string,
  subscriber: Subscriber,
  arenaService: ArenaService,
  afterSequence?: number,
): () => void {
  let state = pollers.get(arenaId);

  if (!state) {
    state = {
      subscribers: new Set(),
      pollTimer: null,
      heartbeatTimer: null,
      lastRoundState: null,
      lastStatus: null,
      lastSurvivorCount: null,
      seenEliminations: new Set(),
      sequence: 0,
      history: [],
      lastSnapshot: null,
      consecutiveFailures: 0,
      rollbackEpoch: getRollbackGuard().getEpoch(),
    };
    pollers.set(arenaId, state);
  }

  state.subscribers.add(subscriber);

  const plan = planReplay(state.lastSnapshot, state.history, state.sequence, afterSequence);
  if (plan.kind === "replay") {
    plan.items.forEach((item) => subscriber.sendEvent(item.event, item.payload, item.sequence));
    console.info(JSON.stringify({ event: "arena_stream_replay_success", arenaId, afterSequence, replayed: plan.items.length }));
  } else if (plan.kind === "snapshot") {
    subscriber.sendSnapshot(plan.payload, plan.sequence);
  }

  // If this is the first subscriber, start the poll loop
  if (state.subscribers.size === 1) {
    startPollLoop(arenaId, state, arenaService);
  }

  // Return unsubscribe function
  return () => {
    state!.subscribers.delete(subscriber);
    subscriber.onCleanup?.();

    // If no more subscribers, stop the poll loop
    if (state!.subscribers.size === 0) {
      stopPollLoop(state!);
      console.info(JSON.stringify({ event: "arena_stream_idle", arenaId }));
    }
  };
}

/** Reset all poller state. Test seam only. */
export function resetPollersForTest(): void {
  for (const state of pollers.values()) stopPollLoop(state);
  pollers.clear();
  arenaPollScheduler.stop();
  pollerConcurrencyLimiter.resetForTest();
}

function startPollLoop(
  arenaId: string,
  state: ArenaPollerState,
  arenaService: ArenaService,
): void {
  // Heartbeat to keep connections alive. Retained even while publication is
  // suppressed so freshness signals continue for unchanged arenas (#1500).
  state.heartbeatTimer = setInterval(() => {
    for (const sub of state.subscribers) {
      try {
        sub.sendEvent("__heartbeat", { ts: Date.now(), instanceId: state.instanceId });
      } catch {
        // Client may have disconnected — cleanup will remove it
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const fanoutEvent = (event: string, envelope: Record<string, unknown>): void => {
    state.history.push({ event, payload: envelope, sequence: envelope.sequence as number });
    if (state.history.length > HISTORY_LIMIT) {
      state.history.splice(0, state.history.length - HISTORY_LIMIT);
    }
    for (const sub of state.subscribers) {
      try {
        sub.sendEvent(event, envelope, envelope.sequence as number);
      } catch {
        // Client disconnected
      }
    }
  };

  /**
   * Called by the pipeline only when the canonical snapshot fingerprint
   * changed: emits any delta events first (they are superseded by the
   * authoritative full snapshot that follows), then the versioned snapshot.
   */
  const publishSnapshot = async (snapshot: ArenaSnapshot, meta: ArenaSnapshotMeta): Promise<void> => {
    const isFirstPublish = meta.previousVersion === null;

    if (!isFirstPublish) {
      const enqueue = (event: string, payload: unknown): void => {
        fanoutEvent(event, {
          type: event,
          sequence: ++state.sequence,
          arenaId,
          payload,
          createdAt: new Date().toISOString(),
          instanceId: state.instanceId,
        });
      };

      for (const elimination of snapshot.recentEliminations) {
        if (!state.seenEliminations.has(elimination.id)) {
          state.seenEliminations.add(elimination.id);
          enqueue("player_eliminated", elimination);
        }
      }
      if (snapshot.lastRoundState === "RESOLVED" && state.lastRoundState !== "RESOLVED") {
        enqueue("round_resolved", { arenaId: snapshot.arenaId, roundNumber: snapshot.currentRound, playerCount: snapshot.playerCount, survivorCount: snapshot.survivorCount, status: snapshot.status });
      }
      const isTerminal = snapshot.status === "settled" || snapshot.survivorCount <= 1;
      const wasTerminal = state.lastStatus === "settled" || (state.lastSurvivorCount !== null && state.lastSurvivorCount <= 1);
      if (isTerminal && !wasTerminal) {
        enqueue("game_finished", { arenaId: snapshot.arenaId, roundNumber: snapshot.currentRound, survivorCount: snapshot.survivorCount, status: snapshot.status });
      }
    }

    const envelope = {
      type: "snapshot",
      sequence: ++state.sequence,
      arenaId,
      payload: snapshot,
      createdAt: new Date().toISOString(),
      version: meta.version,
      previousVersion: meta.previousVersion,
      instanceId: state.instanceId,
    };
    state.lastSnapshot = { payload: envelope, sequence: envelope.sequence };
    state.history.push({ event: "snapshot", payload: envelope, sequence: envelope.sequence });
    if (state.history.length > HISTORY_LIMIT) {
      state.history.splice(0, state.history.length - HISTORY_LIMIT);
    }
    for (const sub of state.subscribers) {
      try {
        sub.sendSnapshot(envelope, envelope.sequence);
      } catch {
        // Client disconnected
      }
    }

    state.lastRoundState = snapshot.lastRoundState;
    state.lastStatus = snapshot.status;
    state.lastSurvivorCount = snapshot.survivorCount;
    snapshot.recentEliminations.forEach((entry) => state.seenEliminations.add(entry.id));
  };

  const stages = createArenaPollStages(arenaId, arenaService, publishSnapshot);
  state.instanceId = randomUUID();

  const runPollTask = async (): Promise<void> => {
    if (state.subscribers.size === 0) return;

    try {
      // While ledger rollback recovery is active nothing newer may be
      // published (#1490). The ledger is refreshed first so the detector has
      // seen the latest identity, and the guard is re-checked after the
      // snapshot read in case the rollback was exposed while it ran.
      await refreshLedgerIdentity();
      if (getRollbackGuard().isQuarantined()) return;
      const snapshot = await getSorobanBreaker().fire(() =>
        arenaService.getSnapshot(arenaId),
      );
      if (getRollbackGuard().isQuarantined()) return;
      const epoch = getRollbackGuard().getEpoch();
      if (state.rollbackEpoch !== epoch) {
        // A rollback happened since the last publish: drop baselines, seen
        // eliminations and replay history so a fresh snapshot goes out. The
        // sequence counter is kept so client cursors stay monotonic.
        state.rollbackEpoch = epoch;
        state.lastRoundState = null;
        state.lastStatus = null;
        state.lastSurvivorCount = null;
        state.seenEliminations.clear();
        state.history.length = 0;
        state.lastSnapshot = null;
      }
      state.consecutiveFailures = 0;

      const outcome = await runArenaPollStages(stages);
      arenaPollsTotal.inc({ outcome: "ok" });
      state.consecutiveFailures = 0;
      state.snapshotMeta = outcome.meta;

      if (outcome.kind === "suppressed") {
        arenaSuppressedPublishesTotal.inc();
        console.info(JSON.stringify({
          event: "arena_snapshot_suppressed",
          arenaId,
          version: outcome.meta.version,
          heartbeatAt: outcome.meta.heartbeatAt,
        }));
      } else {
        arenaSemanticChangesTotal.inc();
      }
    } catch (error) {
      arenaPollsTotal.inc({ outcome: "error" });
      arenaPollerRetriesTotal.inc({ reason: "poll_error" });
      state.consecutiveFailures += 1;
      // Broadcast error to all subscribers
      for (const sub of state.subscribers) {
        try {
          sub.sendEvent("error", {
            type: "error",
            sequence: ++state.sequence,
            arenaId,
            payload: {
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to stream arena updates",
            },
            createdAt: new Date().toISOString(),
            instanceId: state.instanceId,
          });
        } catch {
          // Client disconnected
        }
      }
    }
  };

  // Main poll loop with bounded concurrency & backpressure (#1433)
  const poll = async (): Promise<void> => {
    if (state.subscribers.size === 0) return;

    try {
      await pollerConcurrencyLimiter.executeBounded(arenaId, runPollTask);
    } finally {
      if (state.subscribers.size > 0) {
        state.pollTimer = setTimeout(() => {
          void poll();
        }, computePollDelay(state.consecutiveFailures, {
          roundState: state.lastRoundState,
          subscribersCount: state.subscribers.size,
          commitDeadline: state.commitDeadline,
          revealDeadline: state.revealDeadline,
        }));
      }
    }
  };

  state.pollNow = () => {
    void poll();
  };

  void poll();
}

function stopPollLoop(state: ArenaPollerState): void {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}


