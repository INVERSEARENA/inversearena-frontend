"use client";

import { useCallback } from "react";
import { usePolling } from "@/shared/lib/hooks/usePolling";
import { fetchPlayerStatus } from "@/shared/lib/stellar/stellar-transactions";
import type { PlayerStatus } from "@/shared/lib/stellar/contract-state";

const POLL_INTERVAL_MS = 5_000;

export interface UsePlayerStatusReturn {
  /** `null` while unknown: no player, not yet read, or the latest read failed. */
  status: PlayerStatus | null;
  refresh: () => void;
}

/**
 * Poll the connected player's `get_player_status` (#1582), independently of
 * the arena-state read, so action gating never depends on another call
 * succeeding. A failed read reports `null` rather than the last value, and a
 * result is only used for the arena and player it was read for.
 */
export function usePlayerStatus(arenaId: string, playerAddress?: string): UsePlayerStatusReturn {
  const key = arenaId && playerAddress ? `${arenaId}:${playerAddress}` : null;
  const fetcher = useCallback(
    async () => ({ key, status: await fetchPlayerStatus(arenaId, playerAddress ?? "") }),
    [arenaId, playerAddress, key],
  );
  const { data, error, refresh } = usePolling(fetcher, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: key !== null,
  });

  const current = key !== null && !error && data?.key === key;
  return { status: current ? data.status : null, refresh };
}
