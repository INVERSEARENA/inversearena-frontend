"use client";

/**
 * useLobbyData — data-fetching hook for the arena lobby (#1604).
 *
 * Encapsulates all polling and state for arena stats and participant lists,
 * extracted from ArenaLobbyClient so the parent can stay under 150 lines and
 * the data layer can be tested without a rendered component.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";

// ── Schemas ──────────────────────────────────────────────────────────────

const arenaParticipantSchema = z.object({
  id: z.string(),
  walletAddress: z.string(),
  choice: z.enum(["heads", "tails"]).nullable(),
  stake: z.number(),
  status: z.enum(["READY", "ACTIVE", "ELIMINATED"]),
  roundNumber: z.number(),
  joinedAt: z.string(),
});

const arenaStatsSchema = z.object({
  arenaId: z.string(),
  arenaName: z.string(),
  currentPot: z.number(),
  playerCount: z.number(),
  maxPlayers: z.number(),
  survivorCount: z.number(),
  currentRound: z.number(),
  entryFee: z.number(),
  stakeToken: z.string(),
  joinDeadline: z.string().nullable(),
  yieldAccrued: z.number(),
  status: z.string(),
  lastUpdated: z.string(),
  degraded: z.boolean().optional(),
  ledgerSequence: z.number().nullable().optional(),
  snapshotVerifiedAt: z.string().nullable().optional(),
});

const arenaParticipantsResponseSchema = z.object({
  arenaId: z.string(),
  total: z.number(),
  nextCursor: z.number().nullable(),
  hasMore: z.boolean(),
  items: z.array(arenaParticipantSchema),
});

export type ArenaStats = z.infer<typeof arenaStatsSchema>;
export type ArenaParticipant = z.infer<typeof arenaParticipantSchema>;

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

// ── Hook ─────────────────────────────────────────────────────────────────

export interface UseLobbyDataProps {
  arenaId: string;
  initialStats: ArenaStats | null;
  initialParticipants: ArenaParticipant[];
  initialNextCursor: number | null;
  notFound?: boolean;
}

export interface UseLobbyDataResult {
  stats: ArenaStats | null;
  participants: ArenaParticipant[];
  nextCursor: number | null;
  hasMore: boolean;
  loadingStats: boolean;
  loadingParticipants: boolean;
  error: string | null;
  fetchStats: () => Promise<void>;
  fetchParticipants: (cursor?: number, replace?: boolean) => Promise<void>;
}

export function useLobbyData({
  arenaId,
  initialStats,
  initialParticipants,
  initialNextCursor,
  notFound = false,
}: UseLobbyDataProps): UseLobbyDataResult {
  const [stats, setStats] = useState<ArenaStats | null>(initialStats);
  const [participants, setParticipants] =
    useState<ArenaParticipant[]>(initialParticipants);
  const [nextCursor, setNextCursor] = useState<number | null>(
    initialNextCursor,
  );
  const [hasMore, setHasMore] = useState(Boolean(initialNextCursor !== null));
  const [loadingStats, setLoadingStats] = useState(false);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mergeParticipants = useCallback(
    (incoming: ArenaParticipant[]) => {
      setParticipants((current) => {
        const map = new Map<string, ArenaParticipant>();
        for (const p of incoming) map.set(p.id, p);
        for (const p of current) {
          if (!map.has(p.id)) map.set(p.id, p);
        }
        return Array.from(map.values());
      });
    },
    [],
  );

  const fetchStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const response = await fetch(`${API_BASE}/api/arenas/${arenaId}/stats`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Stats request failed (${response.status})`);
      }
      const json = await response.json();
      const parsed = arenaStatsSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Invalid stats response: ${parsed.error.message}`);
      }
      setStats(parsed.data);
      setError(null);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to refresh arena stats",
      );
    } finally {
      setLoadingStats(false);
    }
  }, [arenaId]);

  const fetchParticipants = useCallback(
    async (cursor = 0, replace = false) => {
      setLoadingParticipants(true);
      try {
        const params = new URLSearchParams({
          limit: "12",
          cursor: String(cursor),
        });
        const response = await fetch(
          `${API_BASE}/api/arenas/${arenaId}/participants?${params.toString()}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error(`Participants request failed (${response.status})`);
        }
        const json = await response.json();
        const parsed = arenaParticipantsResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error(
            `Invalid participants response: ${parsed.error.message}`,
          );
        }
        const data = parsed.data;
        if (replace || cursor === 0) {
          mergeParticipants(data.items);
        } else {
          setParticipants((current) => [...current, ...data.items]);
        }
        setNextCursor(data.nextCursor);
        setHasMore(data.hasMore);
        setError(null);
      } catch (fetchError) {
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Failed to refresh participants",
        );
      } finally {
        setLoadingParticipants(false);
      }
    },
    [arenaId, mergeParticipants],
  );

  // Sync initial SSR props when arenaId changes.
  useEffect(() => {
    setStats(initialStats);
    setParticipants(initialParticipants);
    setNextCursor(initialNextCursor);
    setHasMore(initialNextCursor !== null);
  }, [initialStats, initialParticipants, initialNextCursor]);

  // Polling intervals.
  const isOpen = stats?.status === "open";
  useEffect(() => {
    if (notFound) return;

    void fetchStats();
    void fetchParticipants(0, true);

    const statsTimer = window.setInterval(() => {
      void fetchStats();
    }, 10_000);

    const participantsTimer = window.setInterval(() => {
      if (isOpen) {
        void fetchParticipants(0, true);
      }
    }, 5_000);

    return () => {
      window.clearInterval(statsTimer);
      window.clearInterval(participantsTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arenaId, notFound, isOpen]);

  // Stable merged list (deduped by id).
  const mergedParticipants = useMemo(() => {
    const map = new Map<string, ArenaParticipant>();
    for (const p of participants) map.set(p.id, p);
    return Array.from(map.values());
  }, [participants]);

  return {
    stats,
    participants: mergedParticipants,
    nextCursor,
    hasMore,
    loadingStats,
    loadingParticipants,
    error,
    fetchStats,
    fetchParticipants,
  };
}
