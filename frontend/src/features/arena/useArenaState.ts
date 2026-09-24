import { useState, useEffect, useRef, useCallback } from "react";
import { fetchArenaState } from "@/shared-d/utils/stellar-transactions";
import type { ArenaState, ArenaStateStatus, ArenaStateFromContract } from "@/shared-d/types/contract-state";

export type ArenaHealthStatus = "connected" | "degraded" | "offline";



export interface UseArenaStateReturn {
  state: ArenaState | null;
  health: ArenaHealthStatus;
  /** Epoch ms of the last successful chain-state read; null before the first. */
  lastSyncedAt: number | null;
  /**
   * Deterministically converge optimistic/local state to the authoritative
   * chain state (#1385). Re-reads the Soroban contract and replaces the
   * hook's state with the fresh snapshot. Callers drive this after a
   * transaction's confirmation is reconciled: SUCCESS, REJECTED, and TIMEOUT
   * all end by calling `reconcile(publicKey)` so the UI never keeps a stale
   * optimistic assumption. Resolves the fresh `ArenaState` (or null when no
   * arenaId is configured); rethrows the underlying fetch error unchanged so
   * callers can decide how to surface a failed convergence.
   */
  reconcile: (publicKey?: string) => Promise<ArenaState | null>;
}

export function toArenaState(data: ArenaStateFromContract): ArenaState {
  const id = data.arenaId;
  const currentRound = data.contractArenaState.round;
  const isUserIn = data.contractUserState.active;
  const hasWon = data.contractUserState.won;
  const currentStake = Number(data.contractArenaState.stakes) / 10_000_000; // Assuming 7 decimal places for display
  const potentialPayout = Number(data.contractArenaState.payouts) / 10_000_000; // Assuming 7 decimal places for display

  return {
    id,
    status: (function mapState(): ArenaStateStatus {
      if (data.gameState === null) return "open";
      if (hasWon && data.gameState === 4) return "finished";
      switch (data.gameState) {
        case 0: return "open";
        case 1: return "round_active";
        case 2: return "resolving";
        case 3: return "cancelled";
        case 4: return "settled";
        default: return "open";
      }
    })(),
    survivorsCount: data.playerCount,
    maxCapacity: data.contractArenaState.capacity,
    currentRound,
    isUserIn,
    hasWon,
    currentStake,
    potentialPayout,
    claimReady: false,
    entryFee: data.entryFee ?? 0,
    playerCount: data.playerCount,
    survivors: data.contractArenaState.survivors,
    capacity: data.contractArenaState.capacity,
    round: data.contractArenaState.round,
    stakes: data.contractArenaState.stakes,
    payouts: data.contractArenaState.payouts,
    commitDeadline: data.commitDeadline,
    revealDeadline: data.revealDeadline,
  };
}

export function useArenaState(arenaId: string): UseArenaStateReturn {
  const [state, setState] = useState<ArenaState | null>(null);
  const [health, setHealth] = useState<ArenaHealthStatus>("connected");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const errorCount = useRef(0);
  const timeoutId = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);

  const applyChainState = useCallback((data: ArenaStateFromContract): ArenaState => {
    const nextState = toArenaState(data);
    setState(nextState);
    setLastSyncedAt(Date.now());
    errorCount.current = 0;
    setHealth("connected");
    return nextState;
  }, []);

  const reconcile = useCallback(
    async (publicKey?: string): Promise<ArenaState | null> => {
      if (!arenaId) return null;

      // A reconcile read is the same authoritative read the poll loop uses —
      // passing the caller's wallet address (when given) additionally populates
      // the user-scoped fields (isUserIn / hasWon / currentStake).
      const data = await fetchArenaState(arenaId, publicKey ?? "");

      if (!isMounted.current) return null;
      return applyChainState(data);
    },
    [arenaId, applyChainState],
  );

  useEffect(() => {
    isMounted.current = true;

    if (!arenaId) {
      setState(null);
      setHealth("connected");
      setLastSyncedAt(null);
      return () => {
        isMounted.current = false;
      };
    }

    async function poll() {
      try {
        // fetchArenaState expects (arenaId, userAddress) — pass empty string when no address
        const data = await fetchArenaState(arenaId, "");

        if (!isMounted.current) return;

        const nextState = toArenaState(data);
        if (nextState.hasWon) {
          try {
            const response = await fetch(`/api/payouts/claim-readiness/${encodeURIComponent(arenaId)}`);
            if (response.ok) nextState.claimReady = ((await response.json()) as { ready: boolean }).ready;
          } catch {
            nextState.claimReady = false;
          }
        }
        if (!isMounted.current) return;
        setState(nextState);
        setLastSyncedAt(Date.now());
        errorCount.current = 0;
        setHealth("connected");

        // Slow down when game is finished
        const interval = nextState.state === "finished" ? 30_000 : 5_000;
        timeoutId.current = setTimeout(poll, interval);
      } catch {
        if (!isMounted.current) return;

        errorCount.current++;
        setHealth(errorCount.current > 3 ? "offline" : "degraded");

        // Exponential backoff: 5s → 10s → 20s → max 60s
        const backoff = Math.min(5_000 * 2 ** (errorCount.current - 1), 60_000);
        timeoutId.current = setTimeout(poll, backoff);
      }
    }

    poll();

    return () => {
      isMounted.current = false;
      if (timeoutId.current !== null) {
        clearTimeout(timeoutId.current);
        timeoutId.current = null;
      }
    };
  }, [arenaId, applyChainState]);

  return { state, health, lastSyncedAt, reconcile };
}
