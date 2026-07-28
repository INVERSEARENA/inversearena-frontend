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

interface Subscriber {
  /** Send an SSE event to this client. */
  sendEvent: (event: string, payload: unknown) => void;
  /** Send raw SSE data (for snapshots). */
  sendSnapshot: (data: unknown) => void;
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
  consecutiveFailures: number;
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
      consecutiveFailures: 0,
    };
    pollers.set(arenaId, state);
  }

  state.subscribers.add(subscriber);

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
      pollers.delete(arenaId);
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
      const snapshot = await getSorobanBreaker().fire(() =>
        arenaService.getSnapshot(arenaId),
      );
      state.consecutiveFailures = 0;
      const isFirstPoll = state.lastRoundState === null && state.lastStatus === null;

      if (isFirstPoll) {
        // First poll: send initial snapshot to all subscribers
        state.lastRoundState = snapshot.lastRoundState;
        state.lastStatus = snapshot.status;
        state.lastSurvivorCount = snapshot.survivorCount;
        snapshot.recentEliminations.forEach((entry) => state!.seenEliminations.add(entry.id));

        for (const sub of state.subscribers) {
          try {
            sub.sendSnapshot({
              type: "snapshot",
              sequence: ++state.sequence,
              arenaId,
              payload: snapshot,
              createdAt: new Date().toISOString(),
            });
          } catch {
            // Client disconnected
          }
        }
      } else {
        // Subsequent polls: detect changes and broadcast events
        for (const sub of state.subscribers) {
          try {
            // Send new eliminations
            for (const elimination of snapshot.recentEliminations) {
              if (state.seenEliminations.has(elimination.id)) continue;
              state.seenEliminations.add(elimination.id);
              sub.sendEvent("player_eliminated", {
                type: "player_eliminated",
                sequence: ++state.sequence,
                arenaId,
                payload: elimination,
                createdAt: new Date().toISOString(),
              });
            }

            // Send round_resolved
            if (
              snapshot.lastRoundState === "RESOLVED" &&
              state.lastRoundState !== "RESOLVED"
            ) {
              sub.sendEvent("round_resolved", {
                type: "round_resolved",
                sequence: ++state.sequence,
                arenaId,
                payload: {
                  arenaId: snapshot.arenaId,
                  roundNumber: snapshot.currentRound,
                  playerCount: snapshot.playerCount,
                  survivorCount: snapshot.survivorCount,
                  status: snapshot.status,
                },
                createdAt: new Date().toISOString(),
              });
            }

            // Send game_finished
            const isTerminal =
              snapshot.status === "settled" || snapshot.survivorCount <= 1;
            const wasTerminal =
              state.lastStatus === "settled" ||
              (state.lastSurvivorCount !== null && state.lastSurvivorCount <= 1);
            if (isTerminal && !wasTerminal) {
              sub.sendEvent("game_finished", {
                type: "game_finished",
                sequence: ++state.sequence,
                arenaId,
                payload: {
                  arenaId: snapshot.arenaId,
                  roundNumber: snapshot.currentRound,
                  survivorCount: snapshot.survivorCount,
                  status: snapshot.status,
                },
                createdAt: new Date().toISOString(),
              });
            }
          } catch {
            // Client disconnected — will be cleaned up
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
