// Hook for monitoring system health

import { useState, useEffect } from "react";
import type { SystemHealth } from "../types";
import { fetchSystemHealth } from "../api/adminApi";

export function useSystemHealth(pollingInterval = 30000) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const check = async () => {
    setError(null);
    try {
      const data = await fetchSystemHealth();
      setHealth(data);
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error"));
      setIsLoading(false);
    }
  };

  useEffect(() => {
    check();
    
    // Set up polling if interval is provided
    if (pollingInterval > 0) {
      const intervalId = setInterval(check, pollingInterval);
      return () => clearInterval(intervalId);
    }
  }, [pollingInterval]);

  return {
    health,
    isLoading,
    error,
    refetch: check,
  };
}
