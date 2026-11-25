import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchWatchlist, watchArena, unwatchArena } from "../api/watchlistClient";
import { queryKeys } from "@/shared/lib/query/queryClient";

export interface UseWatchlistReturn {
  watchedArenaIds: string[];
  isLoading: boolean;
  error: string | null;
  isWatched: (arenaId: string) => boolean;
  toggle: (arenaId: string) => Promise<void>;
}

export function useWatchlist(token: string | null): UseWatchlistReturn {
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.watchlist.all(token),
    queryFn: async () => {
      if (!token) return [];
      return await fetchWatchlist(token);
    },
    enabled: Boolean(token),
  });

  const watchedArenaIds = query.data ?? [];

  const isWatched = useCallback(
    (arenaId: string) => watchedArenaIds.includes(arenaId),
    [watchedArenaIds],
  );

  const toggle = useCallback(
    async (arenaId: string) => {
      if (!token) {
        setMutationError("Sign in to manage your watchlist.");
        return;
      }

      setMutationError(null);
      const currentlyWatched = watchedArenaIds.includes(arenaId);
      const optimistic = currentlyWatched
        ? watchedArenaIds.filter((id) => id !== arenaId)
        : [...watchedArenaIds, arenaId];

      queryClient.setQueryData(queryKeys.watchlist.all(token), optimistic);

      try {
        const result = currentlyWatched
          ? await unwatchArena(arenaId, token)
          : await watchArena(arenaId, token);
        queryClient.setQueryData(queryKeys.watchlist.all(token), result);
      } catch (err) {
        // Roll back
        queryClient.setQueryData(queryKeys.watchlist.all(token), watchedArenaIds);
        setMutationError(err instanceof Error ? err.message : "Could not update your watchlist.");
      }
    },
    [token, watchedArenaIds, queryClient],
  );

  return {
    watchedArenaIds,
    isLoading: query.isLoading,
    error:
      mutationError ??
      (query.error
        ? query.error instanceof Error
          ? query.error.message
          : "Could not load watchlist."
        : null),
    isWatched,
    toggle,
  };
}
