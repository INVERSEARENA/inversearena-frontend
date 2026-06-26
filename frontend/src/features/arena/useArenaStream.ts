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
  return userId.length > 10 ? `${userId.slice(0, 5)}...${userId.slice(-4)}` : userId;
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

export function useArenaStream(arenaId: string): UseArenaStreamReturn {
  const [status, setStatus] = useState<UseArenaStreamReturn["status"]>("idle");
  const [snapshot, setSnapshot] = useState<ArenaStreamSnapshot | null>(null);
  const [feed, setFeed] = useState<ArenaEliminationFeedItem[]>([]);
  const [latestEvent, setLatestEvent] = useState<ArenaStreamEvent | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const shouldReconnectRef = useRef(false);

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
      reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30_000);

      retryRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    const handleEvent = (event: MessageEvent<string>): void => {
      const parsed = JSON.parse(event.data) as ArenaStreamEvent;
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
    };

    const connect = (): void => {
      if (!shouldReconnectRef.current) return;

      setStatus(sourceRef.current ? "reconnecting" : "connecting");
      clearConnection();

      try {
        const source = new EventSource(`/api/arenas/${arenaId}/stream`);
        sourceRef.current = source;

        source.onopen = () => {
          reconnectDelayRef.current = 1000;
          setStatus("connected");
        };

        source.addEventListener("snapshot", handleEvent as EventListener);
        source.addEventListener("player_eliminated", handleEvent as EventListener);
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

    return () => {
      shouldReconnectRef.current = false;
      clearConnection();
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
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
