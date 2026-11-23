"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/shared/lib/api/client";
import type { HostReputation } from "./host-reputation-types";
import { computeReputationScore, computeReputationTier, HOST_REPUTATION_VERSION } from "./host-reputation-types";

export function useHostReputation(hostAddress: string | undefined) {
  const [reputation, setReputation] = useState<HostReputation | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!hostAddress) return;
    let cancelled = false;

    const load = async () => {
      setStatus("loading");
      try {
        const json = await apiClient.get<HostReputation>(`/api/hosts/${hostAddress}/reputation`);

        // Recompute client-side score from breakdown so the UI stays consistent
        // even when the backend sends a stale cached score.
        const score = computeReputationScore(json.breakdown);
        const data: HostReputation = {
          ...json,
          score,
          tier: computeReputationTier(score),
          formulaVersion: HOST_REPUTATION_VERSION,
        };
        if (!cancelled) {
          setReputation(data);
          setStatus("success");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load reputation");
          setStatus("error");
        }
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [hostAddress]);

  return { reputation, status, error };
}
