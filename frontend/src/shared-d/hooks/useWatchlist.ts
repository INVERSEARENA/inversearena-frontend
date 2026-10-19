import { useCallback, useEffect, useState } from "react";
import { fetchWatchlist, watchArena, unwatchArena } from "../services/watchlistClient";

export interface UseWatchlistReturn {
  watchedArenaIds: string[];
  isLoading: boolean;
  error: string | null;
  isWatched: (arenaId: string) => boolean;
  toggle: (arenaId: string) => Promise<void>;
}

/**
 * Arena watchlist synced to the authenticated profile (#1402). Toggling
 * updates local state optimistically, then reconciles with the server's
 * response (which reflects the idempotent server-side operation) rather
 * than trusting the optimistic guess — so a toggle that raced with
 * another device's change still ends up showing the server's true state.
 */
export function useWatchlist(token: string | null): UseWatchlistReturn {
  const [watchedArenaIds, setWatchedArenaIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setWatchedArenaIds([]);
      return;
    }

    let active = true;
    setIsLoading(true);
    void fetchWatchlist(token)
      .then((ids) => {
        if (active) setWatchedArenaIds(ids);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load watchlist.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [token]);

  const isWatched = useCallback((arenaId: string) => watchedArenaIds.includes(arenaId), [watchedArenaIds]);

  const toggle = useCallback(
    async (arenaId: string) => {
      if (!token) {
        setError("Sign in to manage your watchlist.");
        return;
      }

      const currentlyWatched = watchedArenaIds.includes(arenaId);
      setError(null);
      // Optimistic update, reconciled below with the server's actual result.
      setWatchedArenaIds((prev) =>
        currentlyWatched ? prev.filter((id) => id !== arenaId) : [...prev, arenaId],
      );

      try {
        const result = currentlyWatched
          ? await unwatchArena(arenaId, token)
          : await watchArena(arenaId, token);
        setWatchedArenaIds(result);
      } catch (err) {
        // Roll back the optimistic change on failure.
        setWatchedArenaIds((prev) =>
          currentlyWatched ? [...prev, arenaId] : prev.filter((id) => id !== arenaId),
        );
        setError(err instanceof Error ? err.message : "Could not update your watchlist.");
      }
    },
    [token, watchedArenaIds],
  );

  return { watchedArenaIds, isLoading, error, isWatched, toggle };
}
