"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/shared/lib/api/client";
import type { PlayerAchievement } from "./achievement-types";

export function usePlayerAchievements(address: string | undefined) {
  const [achievements, setAchievements] = useState<PlayerAchievement[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | undefined>();
  const [pendingToast, setPendingToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setStatus("loading");
    try {
      const data = await apiClient.get<PlayerAchievement[]>(
        `/api/players/${address}/achievements`,
      );
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
