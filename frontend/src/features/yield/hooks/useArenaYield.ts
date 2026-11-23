"use client";

import { useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiClient } from "@/shared/lib/api/client";
import { queryKeys } from "@/shared/lib/query/queryClient";

// ── Zod schemas for runtime validation ─────────────────────────────
const yieldPointSchema = z.object({
  round: z.number(),
  timestamp: z.string(),
  rateBps: z.string().nullable(),
  accrued: z.string(),
  cumulative: z.string(),
});

const yieldResponseSchema = z.object({
  arenaId: z.string(),
  asset: z.string(),
  assetDecimals: z.number(),
  points: z.array(yieldPointSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  finished: z.boolean(),
});

export type ArenaYieldPoint = z.infer<typeof yieldPointSchema>;
export type ArenaYieldResponse = z.infer<typeof yieldResponseSchema>;

export interface UseArenaYieldReturn {
  points: ArenaYieldPoint[];
  asset: string;
  finished: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useArenaYield(arenaId: string | null): UseArenaYieldReturn {
  const query = useQuery({
    queryKey: queryKeys.arena.yield(arenaId),
    queryFn: async () => {
      if (!arenaId) return null;
      const json = await apiClient.get<unknown>(
        `/api/arenas/${encodeURIComponent(arenaId)}/yield`,
        { params: { limit: "500" } },
      );
      return yieldResponseSchema.parse(json);
    },
    enabled: Boolean(arenaId),
  });

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const points = useMemo(() => query.data?.points ?? [], [query.data]);

  return {
    points,
    asset: query.data?.asset ?? "",
    finished: query.data?.finished ?? false,
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load yield"
      : null,
    refetch,
  };
}
