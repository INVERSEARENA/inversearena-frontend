"use client";

import { useEffect, useState } from "react";
import type { HostReputation } from "./host-reputation-types";
import { computeReputationScore, computeReputationTier, HOST_REPUTATION_VERSION } from "./host-reputation-types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

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
        const res = await fetch(`${API_BASE}/api/hosts/${hostAddress}/reputation`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

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
