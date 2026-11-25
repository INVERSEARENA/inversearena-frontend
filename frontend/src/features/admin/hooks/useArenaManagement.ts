// Hook for managing arenas in admin panel

import { useState, useEffect } from "react";
import type { ArenaConfig } from "../types";
import { fetchArenas, updateArenaConfig } from "../api/adminApi";

export function useArenaManagement() {
  const [arenas, setArenas] = useState<ArenaConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadArenas = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchArenas();
      setArenas(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error"));
    } finally {
      setIsLoading(false);
    }
  };

  const updateArena = async (
    arenaId: string,
    config: Partial<ArenaConfig>
  ) => {
    try {
      const updated = await updateArenaConfig(arenaId, config);
      setArenas((prev) =>
        prev.map((arena) => (arena.id === arenaId ? updated : arena))
      );
      return updated;
    } catch (err) {
      throw err instanceof Error ? err : new Error("Failed to update arena");
    }
  };

  useEffect(() => {
    loadArenas();
  }, []);

  return {
    arenas,
    isLoading,
    error,
    refetch: loadArenas,
    updateArena,
  };
}
