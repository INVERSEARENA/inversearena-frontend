"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/lib/api/client";
import { queryKeys } from "@/shared/lib/query/queryClient";
import type { HostReputation } from "./host-reputation-types";
import { computeReputationScore, computeReputationTier, HOST_REPUTATION_VERSION } from "./host-reputation-types";

export function useHostReputation(hostAddress: string | undefined) {
  const query = useQuery({
    queryKey: queryKeys.arena.hostReputation(hostAddress),
    queryFn: async () => {
      const json = await apiClient.get<HostReputation>(`/api/hosts/${hostAddress}/reputation`);
      const score = computeReputationScore(json.breakdown);
      return {
        ...json,
        score,
        tier: computeReputationTier(score),
        formulaVersion: HOST_REPUTATION_VERSION,
      } as HostReputation;
    },
    enabled: Boolean(hostAddress),
  });

  const status: "idle" | "loading" | "success" | "error" =
    !hostAddress ? "idle" : query.isLoading ? "loading" : query.isError ? "error" : "success";

  return {
    reputation: query.data ?? null,
    status,
    error: query.error ? (query.error instanceof Error ? query.error.message : "Failed to load reputation") : undefined,
  };
}
