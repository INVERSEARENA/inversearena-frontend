"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/lib/api/client";
import { queryKeys } from "@/shared/lib/query/queryClient";
import type { PlayerAchievement } from "./achievement-types";

export function usePlayerAchievements(address: string | undefined) {
  const [pendingToast, setPendingToast] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.profile.achievements(address),
    queryFn: async () => {
      return await apiClient.get<PlayerAchievement[]>(`/api/players/${address}/achievements`);
    },
    enabled: Boolean(address),
  });

  const status: "idle" | "loading" | "success" | "error" =
    !address ? "idle" : query.isLoading ? "loading" : query.isError ? "error" : "success";

  const dismissToast = useCallback(() => setPendingToast(null), []);

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    achievements: query.data ?? [],
    status,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load achievements"
      : undefined,
    pendingToast,
    dismissToast,
    refetch,
  };
}
