"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { z } from "zod";
import { apiClient } from "@/shared/lib/api/client";

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

// ── Hook: GET /api/arenas/:id/yield ────────────────────────────────
export function useArenaYield(arenaId: string | null): UseArenaYieldReturn {
  const [data, setData] = useState<ArenaYieldResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchYield = useCallback(async () => {
    if (!arenaId) return;
    setLoading(true);
    setError(null);
    try {
      const json = await apiClient.get<unknown>(
        `/api/arenas/${encodeURIComponent(arenaId)}/yield`,
        { params: { limit: "500" } },
      );
      setData(yieldResponseSchema.parse(json));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load yield");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [arenaId]);

  useEffect(() => {
    if (arenaId) {
      void fetchYield();
    } else {
      setData(null);
      setError(null);
      setLoading(false);
    }
  }, [arenaId, fetchYield]);

  const points = useMemo(() => data?.points ?? [], [data]);

  return {
    points,
    asset: data?.asset ?? "",
    finished: data?.finished ?? false,
    loading,
    error,
    refetch: fetchYield,
  };
}
