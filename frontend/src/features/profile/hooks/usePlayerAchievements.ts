"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlayerAchievement } from "./achievement-types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function usePlayerAchievements(address: string | undefined) {
  const [achievements, setAchievements] = useState<PlayerAchievement[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | undefined>();
  const [pendingToast, setPendingToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setStatus("loading");
    try {
      const res = await fetch(`${API_BASE}/api/players/${address}/achievements`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: PlayerAchievement[] = await res.json();
      setAchievements(data);
      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load achievements");
      setStatus("error");
    }
  }, [address]);

  useEffect(() => { void load(); }, [load]);

  const dismissToast = useCallback(() => setPendingToast(null), []);

  return { achievements, status, error, pendingToast, dismissToast, refetch: load };
}
