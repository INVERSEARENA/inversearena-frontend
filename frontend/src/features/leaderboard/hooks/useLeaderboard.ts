"use client";

import { useState, useEffect, useCallback } from "react";
import type { Survivor } from "../types";

// ── API shape returned by GET /api/leaderboard ─────────────────────
interface ApiPlayer {
  id: string;
  rank: number;
  walletAddress: string;
  survivalStreak: number;
  totalYield: number;
  arenasWon: number;
}

interface ApiResponse {
  players: ApiPlayer[];
  nextCursor: string | null;
}

// ── Map API player → frontend Survivor ────────────────────────────
function toSurvivor(p: ApiPlayer): Survivor {
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

// ── Hook ──────────────────────────────────────────────────────────
export function useLeaderboard(limit = 100) {
  const [survivors, setSurvivors] = useState<Survivor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const token =
        typeof window !== "undefined"
          ? window.localStorage.getItem("accessToken")
          : null;

      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const url = `${API_BASE}/api/leaderboard?limit=${limit}`;
      const res = await fetch(url, { headers });

      if (!res.ok) {
        throw new Error(`Leaderboard request failed: ${res.status}`);
      }

      const data: ApiResponse = await res.json() as ApiResponse;
      setSurvivors(data.players.map(toSurvivor));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load leaderboard";
      setError(message);
      setSurvivors([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void fetchLeaderboard();
  }, [fetchLeaderboard]);

  return { survivors, loading, error, refetch: fetchLeaderboard };
}
