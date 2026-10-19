"use client";

import { useState, useEffect, useCallback } from "react";
import { z } from "zod";
import type { Survivor } from "../types";

// ── Zod schemas for runtime validation ─────────────────────────────
const apiPlayerSchema = z.object({
  id: z.string(),
  rank: z.number(),
  walletAddress: z.string(),
  survivalStreak: z.number(),
  totalYield: z.number(),
  arenasWon: z.number(),
});

const leaderboardApiResponseSchema = z.object({
  players: z.array(apiPlayerSchema),
  nextCursor: z.string().nullable(),
});

// ── API shape returned by GET /api/leaderboard ─────────────────────
export interface LeaderboardApiResponse {
  players: z.infer<typeof apiPlayerSchema>[];
  nextCursor: string | null;
}

// ── Map API player → frontend Survivor ────────────────────────────
function toSurvivor(p: z.infer<typeof apiPlayerSchema>): Survivor {
  return {
    id: p.id,
    agentId: p.walletAddress,
    rank: p.rank,
    survivalStreak: p.survivalStreak,
    totalYield: p.totalYield,
    arenasWon: p.arenasWon,
  };
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export interface UseLeaderboardReturn {
  survivors: Survivor[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
}

// ── Hook ──────────────────────────────────────────────────────────
export function useLeaderboard(limit = 20): UseLeaderboardReturn {
  const [survivors, setSurvivors] = useState<Survivor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const fetchLeaderboard = useCallback(
    async (cursor?: string | null) => {
      setLoading((prev) => !cursor && prev);
      setError(null);

      try {
        const params = new URLSearchParams({ limit: limit.toString() });
        if (cursor) params.set("cursor", cursor);

        const url = `${API_BASE}/api/leaderboard?${params.toString()}`;
        const token =
          typeof window !== "undefined"
            ? window.localStorage.getItem("access_token")
            : null;
        const headers: HeadersInit = token
          ? { Authorization: `Bearer ${token}` }
          : {};
        const res = await fetch(url, { headers });

        if (!res.ok) {
          throw new Error(`Leaderboard request failed: ${res.status}`);
        }

        const json = await res.json();
        const data = leaderboardApiResponseSchema.parse(json);
        const newSurvivors = data.players.map(toSurvivor);

        if (cursor) {
          // Append for pagination
          setSurvivors((prev) => [...prev, ...newSurvivors]);
        } else {
          // Replace for initial load or refresh
          setSurvivors(newSurvivors);
        }

        setNextCursor(data.nextCursor);
        setHasMore(!!data.nextCursor);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load leaderboard";
        setError(message);
        if (!cursor) {
          setSurvivors([]);
        }
        setHasMore(false);
        setNextCursor(null);
      } finally {
        setLoading(false);
      }
    },
    [limit],
  );

  const refetch = useCallback(async () => {
    await fetchLeaderboard(null);
  }, [fetchLeaderboard]);

  const fetchMore = useCallback(async () => {
    if (nextCursor && !loading) {
      await fetchLeaderboard(nextCursor);
    }
  }, [nextCursor, loading, fetchLeaderboard]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { survivors, loading, error, hasMore, nextCursor, refetch, fetchMore };
}
