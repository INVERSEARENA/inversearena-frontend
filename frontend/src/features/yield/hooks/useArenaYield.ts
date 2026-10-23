"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { z } from "zod";

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

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

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
      const token =
        typeof window !== "undefined"
          ? window.localStorage.getItem("access_token")
          : null;
      const headers: HeadersInit = token
        ? { Authorization: `Bearer ${token}` }
        : {};
      const res = await fetch(
        `${API_BASE}/api/arenas/${encodeURIComponent(arenaId)}/yield?limit=500`,
        { headers },
      );
      if (!res.ok) {
        throw new Error(`Yield request failed: ${res.status}`);
      }
      const json = await res.json();
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
