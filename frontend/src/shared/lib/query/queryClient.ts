/**
 * Unified Shared Request Cache & Query Client (#1769).
 *
 * Configures TanStack Query with production defaults:
 *  - 15s stale-time (deduplicating concurrent requests during navigation and re-renders)
 *  - 5m garbage-collection window
 *  - Refetch on window focus
 *  - Canonical resource query keys
 *  - Transaction confirmation & SSE invalidation channels
 *  - User-scoped query eviction on wallet switch
 */

import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { invalidateWalletBalances, resetBalanceCache } from "../stellar/balance-cache";

export const DEFAULT_STALE_TIME_MS = 15_000;
export const DEFAULT_GC_TIME_MS = 5 * 60_000;

let sharedClient: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") {
    return createQueryClient();
  }
  if (!sharedClient) {
    sharedClient = createQueryClient();
  }
  return sharedClient;
}

export function useSafeQueryClient(): QueryClient {
  try {
    return useQueryClient();
  } catch {
    return getQueryClient();
  }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        gcTime: DEFAULT_GC_TIME_MS,
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        retry: (failureCount, error: any) => {
          if (error?.status === 404 || error?.statusCode === 404) return false;
          return failureCount < 2;
        },
      },
    },
  });
}

/**
 * Strongly-typed query keys per domain resource (#1769).
 */
export const queryKeys = {
  profile: {
    root: ["profile"] as const,
    summary: (address?: string, filter?: string) =>
      ["profile", "summary", address ?? "anonymous", filter ?? "all"] as const,
    achievements: (address?: string) =>
      ["profile", "achievements", address ?? "anonymous"] as const,
    referrals: () => ["profile", "referrals"] as const,
  },
  arena: {
    root: ["arena"] as const,
    detail: (id?: string) => ["arena", "detail", id ?? ""] as const,
    stats: (id?: string) => ["arena", "stats", id ?? ""] as const,
    participants: (id?: string) => ["arena", "participants", id ?? ""] as const,
    yield: (id?: string | null) => ["arena", "yield", id ?? ""] as const,
    hostReputation: (hostAddress?: string) =>
      ["arena", "hostReputation", hostAddress ?? ""] as const,
  },
  leaderboard: {
    root: ["leaderboard"] as const,
    list: (params?: unknown) => ["leaderboard", "list", params ?? {}] as const,
  },
  wallet: {
    root: ["wallet"] as const,
    admin: (publicKey?: string | null) => ["wallet", "admin", publicKey ?? "none"] as const,
    balance: (publicKey?: string | null) => ["wallet", "balance", publicKey ?? "none"] as const,
  },
  claims: {
    root: ["claims"] as const,
    inbox: (cursor?: string | null) => ["claims", "inbox", cursor ?? "initial"] as const,
  },
  watchlist: {
    root: ["watchlist"] as const,
    all: (token?: string | null) => ["watchlist", "all", token ?? "anon"] as const,
  },
  staking: {
    root: ["staking"] as const,
    position: (wallet?: string | null) => ["staking", "position", wallet ?? "anonymous"] as const,
  },
} as const;

/**
 * Invalidates relevant cached queries following transaction confirmation (#1769, #1625).
 */
export async function invalidateOnTxConfirmation(
  queryClient: QueryClient,
  address?: string,
  extraKeys?: unknown[][],
): Promise<void> {
  const promises: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: queryKeys.profile.root }),
    queryClient.invalidateQueries({ queryKey: queryKeys.claims.root }),
    queryClient.invalidateQueries({ queryKey: queryKeys.staking.root }),
    queryClient.invalidateQueries({ queryKey: queryKeys.arena.root }),
  ];

  if (extraKeys) {
    for (const key of extraKeys) {
      promises.push(queryClient.invalidateQueries({ queryKey: key }));
    }
  }

  // Cross-layer invalidation for wallet balance cache (#1625)
  if (address) {
    invalidateWalletBalances(address);
  }

  await Promise.all(promises);
}

/**
 * Invalidates cached queries on incoming SSE stream updates (#1769).
 */
export async function invalidateOnSseUpdate(
  queryClient: QueryClient,
  eventType: string,
  payload?: { arenaId?: string; address?: string },
): Promise<void> {
  if (eventType === "round_resolved" || eventType === "round_started") {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.arena.root }),
      queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard.root }),
      queryClient.invalidateQueries({ queryKey: queryKeys.staking.root }),
    ]);
  } else if (eventType === "payout_processed" && payload?.address) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.claims.root }),
      queryClient.invalidateQueries({ queryKey: queryKeys.profile.root }),
    ]);
    invalidateWalletBalances(payload.address);
  } else if (payload?.arenaId) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.arena.detail(payload.arenaId) });
  }
}

/**
 * Clears user-scoped queries when the active wallet changes (#1769).
 * Prevents data leakage between connected wallets.
 */
export function clearUserScopedCache(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: queryKeys.profile.root });
  queryClient.removeQueries({ queryKey: queryKeys.claims.root });
  queryClient.removeQueries({ queryKey: queryKeys.staking.root });
  queryClient.removeQueries({ queryKey: queryKeys.watchlist.root });
  queryClient.removeQueries({ queryKey: queryKeys.wallet.root });
  resetBalanceCache();
}
