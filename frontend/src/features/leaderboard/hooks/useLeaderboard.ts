"use client";

import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { Survivor } from "../model/types";
import { apiClient } from "@/shared/lib/api/client";
import { queryKeys, useSafeQueryClient } from "@/shared/lib/query/queryClient";

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

export interface LeaderboardApiResponse {
  players: z.infer<typeof apiPlayerSchema>[];
  nextCursor: string | null;
}

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

export interface UseLeaderboardReturn {
  survivors: Survivor[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
}

export function useLeaderboard(limit = 20): UseLeaderboardReturn {
  const queryClient = useSafeQueryClient();
  const [paginatedSurvivors, setPaginatedSurvivors] = useState<Survivor[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = useQuery(
    {
      queryKey: queryKeys.leaderboard.list({ limit }),
      queryFn: async () => {
        const params = new URLSearchParams({ limit: limit.toString() });
        const json = await apiClient.get<unknown>("/api/leaderboard", { params });
        const data = leaderboardApiResponseSchema.parse(json);
        return {
          survivors: data.players.map(toSurvivor),
          nextCursor: data.nextCursor,
        };
      },
    },
    queryClient,
  );

  useEffect(() => {
    if (query.data) {
      setNextCursor(query.data.nextCursor);
      // Reset paginated items when root query updates
      setPaginatedSurvivors(null);
    }
  }, [query.data]);

  const survivors = paginatedSurvivors ?? query.data?.survivors ?? [];
  const hasMore = Boolean(nextCursor);

  const refetch = useCallback(async () => {
    setPaginatedSurvivors(null);
    await query.refetch();
  }, [query]);

  const fetchMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: limit.toString(), cursor: nextCursor });
      const json = await apiClient.get<unknown>("/api/leaderboard", { params });
      const data = leaderboardApiResponseSchema.parse(json);
      const more = data.players.map(toSurvivor);
      setPaginatedSurvivors((prev) => [...(prev ?? query.data?.survivors ?? []), ...more]);
      setNextCursor(data.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, limit, query.data]);

  return {
    survivors,
    loading: query.isLoading || loadingMore,
    error: query.error ? (query.error instanceof Error ? query.error.message : "Failed to load leaderboard") : null,
    hasMore,
    nextCursor,
    refetch,
    fetchMore,
  };
}
