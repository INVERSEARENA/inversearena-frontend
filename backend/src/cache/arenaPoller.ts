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

  // Main poll loop
  const poll = async (): Promise<void> => {
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

