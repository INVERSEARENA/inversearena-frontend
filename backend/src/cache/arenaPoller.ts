/**
 * Shared arena SSE poller with fan-out.
 *
 * Instead of each SSE client running its own DB poll loop (N clients = N queries
 * per interval), a single background poller per arena fetches the snapshot and
 * fans it out to all connected subscribers. This keeps DB load constant at
 * 1 query per arena per poll interval, regardless of spectator count.
 */

import type { ArenaService } from "../services/arenaService";
import { getSorobanBreaker } from "../utils/circuitBreaker";
import { refreshLedgerIdentity } from "../services/ledgerClock";
import { getRollbackGuard } from "../services/ledgerContinuity";

interface Subscriber {
  /** Send an SSE event to this client. */
  sendEvent: (event: string, payload: unknown, id?: number) => void;
  /** Send raw SSE data (for snapshots). */
  sendSnapshot: (data: unknown, id?: number) => void;
  /** Called when the subscriber disconnects or the arena is cleaned up. */
  onCleanup?: () => void;
}

interface ArenaPollerState {
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
}

const pollers = new Map<string, ArenaPollerState>();

const POLL_INTERVAL_MS = 2_500;
const POLL_RETRY_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export function computePollDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  return Math.min(
    POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1),
    POLL_RETRY_MAX_MS,
  );
}

function writeSseEvent(
  res: { write: (chunk: string) => void },
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

  if (state.lastSnapshot) {
    const replay = afterSequence === undefined ? [] : state.history.filter((item) => item.sequence > afterSequence);
    if (afterSequence !== undefined && replay.length > 0) {
      replay.forEach((item) => subscriber.sendEvent(item.event, item.payload, item.sequence));
      console.info(JSON.stringify({ event: "arena_stream_replay_success", arenaId, afterSequence, replayed: replay.length }));
    } else if (afterSequence === undefined || afterSequence !== state.sequence) {
      subscriber.sendSnapshot(state.lastSnapshot.payload, state.lastSnapshot.sequence);
    }
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

function startPollLoop(
  arenaId: string,
  state: ArenaPollerState,
  arenaService: ArenaService,
): void {
  // Heartbeat to keep connections alive
  state.heartbeatTimer = setInterval(() => {
    for (const sub of state.subscribers) {
      try {
        sub.sendEvent("__heartbeat", { ts: Date.now() });
      } catch {
        // Client may have disconnected — cleanup will remove it
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

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
      const isFirstPoll = state.lastRoundState === null && state.lastStatus === null;

      if (isFirstPoll) {
        // First poll: send initial snapshot to all subscribers
        state.lastRoundState = snapshot.lastRoundState;
        state.lastStatus = snapshot.status;
        state.lastSurvivorCount = snapshot.survivorCount;
        snapshot.recentEliminations.forEach((entry) => state!.seenEliminations.add(entry.id));

        const snapshotEvent = {
          type: "snapshot",
          sequence: ++state.sequence,
          arenaId,
          payload: snapshot,
          createdAt: new Date().toISOString(),
        };
        state.lastSnapshot = { payload: snapshotEvent, sequence: snapshotEvent.sequence };
        state.history.push({ event: "snapshot", payload: snapshotEvent, sequence: snapshotEvent.sequence });
        for (const sub of state.subscribers) {
          try {
            sub.sendSnapshot(snapshotEvent, snapshotEvent.sequence);
          } catch {
            // Client disconnected
          }
        }
      } else {
        // Subsequent polls: create each event once, then fan out the same cursor.
        const pending: Array<{ event: string; payload: { type: string; sequence: number; arenaId: string; payload: unknown; createdAt: string } }> = [];
        const enqueue = (event: string, payload: unknown): void => {
          const envelope = { type: event, sequence: ++state.sequence, arenaId, payload, createdAt: new Date().toISOString() };
          pending.push({ event, payload: envelope });
          state.history.push({ event, payload: envelope, sequence: envelope.sequence });
          if (state.history.length > 512) state.history.splice(0, state.history.length - 512);
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
        for (const item of pending) {
          for (const sub of state.subscribers) {
            try { sub.sendEvent(item.event, item.payload, item.payload.sequence); } catch { /* disconnected */ }
          }
        }

        state.lastRoundState = snapshot.lastRoundState;
        state.lastStatus = snapshot.status;
        state.lastSurvivorCount = snapshot.survivorCount;
      }
    } catch (error) {
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
          });
        } catch {
          // Client disconnected
        }
      }
    } finally {
      if (state.subscribers.size > 0) {
        state.pollTimer = setTimeout(() => {
          void poll();
        }, computePollDelay(state.consecutiveFailures));
      }
    }
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
