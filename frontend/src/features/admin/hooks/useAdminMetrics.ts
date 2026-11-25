// Hook for fetching and managing admin metrics

import { useState, useEffect } from "react";
import type { AdminMetrics } from "../types";
import { fetchAdminMetrics } from "../api/adminApi";

export function useAdminMetrics() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchAdminMetrics();
      setMetrics(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refetch();
  }, []);

  return {
    metrics,
    isLoading,
    error,
    refetch,
  };
}
