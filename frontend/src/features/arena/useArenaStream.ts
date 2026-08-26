"use client";

import { useEffect, useRef, useState } from "react";

type ArenaStreamEventType =
  | "snapshot"
  | "round_resolved"
  | "player_eliminated"
  | "game_finished";

export interface ArenaStreamEvent<TPayload = Record<string, unknown>> {
  type: ArenaStreamEventType;
  arenaId: string;
  payload: TPayload;
  sequence: number;
  createdAt: string;
}

export interface ArenaEliminationFeedItem {
  id: string;
  label: string;
  roundNumber: number;
  status: "OUT" | "ACTIVE";
  createdAt: string;
}

export interface ArenaStreamSnapshot {
  arenaId: string;
  currentRound: number;
  playerCount: number;
  survivorCount: number;
  status: string;
  recentEliminations: Array<{
    id: string;
    userId: string;
    roundNumber: number;
    reason: string | null;
    eliminatedAt: string;
  }>;
  lastRoundState: string | null;
}

export interface UseArenaStreamReturn {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "error";
  snapshot: ArenaStreamSnapshot | null;
  feed: ArenaEliminationFeedItem[];
  latestEvent: ArenaStreamEvent | null;
}

function formatFeedLabel(userId: string): string {
  return userId.length > 10
    ? `${userId.slice(0, 5)}...${userId.slice(-4)}`
    : userId;
}

/**
 * Validates the basic shape of an ArenaStreamEvent.
 * Returns true if the data has the required type and structure.
 */
function isValidArenaStreamEvent(data: unknown): data is ArenaStreamEvent {
  if (!data || typeof data !== "object") {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Check required fields
  if (
    typeof obj.type !== "string" ||
    typeof obj.arenaId !== "string" ||
    typeof obj.sequence !== "number" ||
    typeof obj.createdAt !== "string"
  ) {
    return false;
  }

  // Check that type is one of the valid types
  const validTypes: ArenaStreamEventType[] = [
    "snapshot",
    "round_resolved",
    "player_eliminated",
    "game_finished",
  ];
  if (!validTypes.includes(obj.type as ArenaStreamEventType)) {
    return false;
  }

  // Check payload exists and is an object
  if (!obj.payload || typeof obj.payload !== "object") {
    return false;
  }

  return true;
}

function appendUniqueFeedItem(
  feed: ArenaEliminationFeedItem[],
  item: ArenaEliminationFeedItem,
): ArenaEliminationFeedItem[] {
  if (feed.some((entry) => entry.id === item.id)) {
    return feed;
  }
  return [item, ...feed].slice(0, 12);
}

// The backend emits a raw SSE comment frame (`: ping ...\n\n`) every ~15s as
// a transport-level keepalive. Comment frames are invisible to EventSource's
// JS API (per spec, they never dispatch an event) — this hook has no way to
// "see" them directly. So a dead-but-not-yet-errored connection (e.g. a
// middlebox silently drops it without a TCP FIN/RST) is instead detected by
// staleness: if 60s pass without *any* observable event, the connection is
// treated as dead and replaced immediately, without waiting for `onerror`
// (which may never fire for a silent black hole).
const STALE_CONNECTION_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 10_000;

export function useArenaStream(arenaId: string): UseArenaStreamReturn {
  const [status, setStatus] = useState<UseArenaStreamReturn["status"]>("idle");
  const [snapshot, setSnapshot] = useState<ArenaStreamSnapshot | null>(null);
  const [feed, setFeed] = useState<ArenaEliminationFeedItem[]>([]);
  const [latestEvent, setLatestEvent] = useState<ArenaStreamEvent | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const shouldReconnectRef = useRef(false);
  // Set to a real timestamp inside the effect below (connect() runs before
  // the watchdog interval is armed) — 0 here is just a pure placeholder so
  // this doesn't call an impure function during render.
  const lastMessageAtRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!arenaId) {
      setStatus("idle");
      setSnapshot(null);
      setFeed([]);
      setLatestEvent(null);
      return;
    }

    shouldReconnectRef.current = true;

    const clearConnection = (): void => {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (!shouldReconnectRef.current) return;

      setStatus("reconnecting");
      clearConnection();

      if (retryRef.current) {
        clearTimeout(retryRef.current);
      }

      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        30_000,
      );

      retryRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    const handleEvent = (event: MessageEvent<string>): void => {
      lastMessageAtRef.current = Date.now();

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch (err) {
        console.error(
          "Failed to parse SSE event data:",
          err,
          "Raw data:",
          event.data,
        );
        // Do not reconnect; JSON parse errors are usually one-off network glitches.
        // The stream stays open and will retry with the next valid frame.
        return;
      }

      if (!isValidArenaStreamEvent(parsed)) {
        console.error("Invalid ArenaStreamEvent shape:", parsed);
        // Schema validation failure; similar to JSON parse error, stay connected.
        return;
      }

      try {
        setLatestEvent(parsed);

        if (parsed.type === "snapshot") {
          const nextSnapshot = parsed.payload as unknown as ArenaStreamSnapshot;
          setSnapshot(nextSnapshot);
          setFeed(
            nextSnapshot.recentEliminations
              .slice()
              .reverse()
              .map((entry) => ({
                id: entry.id,
                label: formatFeedLabel(entry.userId),
                roundNumber: entry.roundNumber,
                status: "OUT",
                createdAt: entry.eliminatedAt,
              })),
          );
          return;
        }

        if (parsed.type === "player_eliminated") {
          const payload = parsed.payload as {
            id: string;
            userId: string;
            roundNumber: number;
            eliminatedAt: string;
          };
          setFeed((current) =>
            appendUniqueFeedItem(current, {
              id: payload.id,
              label: formatFeedLabel(payload.userId),
              roundNumber: payload.roundNumber,
              status: "OUT",
              createdAt: payload.eliminatedAt,
            }),
          );
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  survivorCount: Math.max(0, current.survivorCount - 1),
                }
              : current,
          );
          return;
        }

        if (parsed.type === "round_resolved") {
          const payload = parsed.payload as {
            roundNumber: number;
            playerCount: number;
            survivorCount: number;
            status: string;
          };
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  currentRound: payload.roundNumber,
                  playerCount: payload.playerCount,
                  survivorCount: payload.survivorCount,
                  status: payload.status,
                  lastRoundState: "RESOLVED",
                }
              : current,
          );
          return;
        }

        if (parsed.type === "game_finished") {
          setSnapshot((current) =>
            current ? { ...current, status: "settled" } : current,
          );
        }
      } catch (err) {
        console.error(
          "Error processing ArenaStreamEvent:",
          err,
          "Event:",
          parsed,
        );
        // Error in state update or payload casting; stay connected.
      }
    };

    const connect = (): void => {
      if (!shouldReconnectRef.current) return;

      setStatus(sourceRef.current ? "reconnecting" : "connecting");
      clearConnection();
      // Buys the new attempt time to establish before the watchdog can fire
      // again — otherwise it would keep re-triggering every tick until the
      // fresh connection's first event lands.
      lastMessageAtRef.current = Date.now();

      try {
        const source = new EventSource(`/api/arenas/${arenaId}/stream`);
        sourceRef.current = source;

        source.onopen = () => {
          reconnectDelayRef.current = 1000;
          lastMessageAtRef.current = Date.now();
          setStatus("connected");
        };

        source.addEventListener("snapshot", handleEvent as EventListener);
        source.addEventListener(
          "player_eliminated",
          handleEvent as EventListener,
        );
        source.addEventListener("round_resolved", handleEvent as EventListener);
        source.addEventListener("game_finished", handleEvent as EventListener);

        source.onerror = () => {
          scheduleReconnect();
        };
      } catch {
        scheduleReconnect();
      }
    };

    connect();

    watchdogRef.current = setInterval(() => {
      if (!shouldReconnectRef.current) return;
      if (Date.now() - lastMessageAtRef.current > STALE_CONNECTION_MS) {
        connect();
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      shouldReconnectRef.current = false;
      clearConnection();
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
    };
  }, [arenaId]);

  return {
    status,
    snapshot,
    feed,
    latestEvent,
  };
}
