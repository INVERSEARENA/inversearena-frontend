'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchArenaState } from '@/shared-d/utils/stellar-transactions';

export type GameState = 'JOINING' | 'ACTIVE' | 'RESOLVING' | 'ENDED';

export interface ArenaState {
  arenaId: string;
  timer: number;
  totalYieldPot: number;
  survivorCount: number;
  maxCapacity: number;
  populationSplit: { heads: number; tails: number };
  gameState: GameState;
  roundNumber: number;
  currentStake: number;
  potentialPayout: number;
  isUserIn: boolean;
  hasWon: boolean;
}

interface UseArenaStateOptions {
  refreshInterval?: number;
}

const TERMINAL_STATES: GameState[] = ['ENDED'];
const DEFAULT_REFRESH_INTERVAL = 5000;

function deriveGameState(survivorCount: number, maxCapacity: number): GameState {
  if (survivorCount === maxCapacity) return 'JOINING';
  if (survivorCount === 1) return 'ENDED';
  if (survivorCount <= 0) return 'ENDED';
  return 'ACTIVE';
}

export const useArenaState = (
  arenaId: string,
  userAddress?: string,
  options: UseArenaStateOptions = {}
) => {
  const refreshInterval = options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL;

  const [arenaState, setArenaState] = useState<ArenaState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const data = await fetchArenaState(arenaId, userAddress);

      const gameState = deriveGameState(data.survivorsCount, data.maxCapacity);

      setArenaState({
        arenaId: data.arenaId,
        timer: 0, // TODO: Source from contract when available
        totalYieldPot: data.potentialPayout,
        survivorCount: data.survivorsCount,
        maxCapacity: data.maxCapacity,
        populationSplit: {
          heads: Math.floor(data.survivorsCount * 0.55),
          tails: Math.ceil(data.survivorsCount * 0.45),
        },
        gameState,
        roundNumber: data.roundNumber,
        currentStake: data.currentStake,
        potentialPayout: data.potentialPayout,
        isUserIn: data.isUserIn,
        hasWon: data.hasWon,
      });

      setError(null);
      return gameState;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch arena state');
      return null;
    }
  }, [arenaId, userAddress]);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;

    const initialFetch = async () => {
      setLoading(true);
      const gameState = await fetchData();
      if (!cancelled) setLoading(false);
      return gameState;
    };

    initialFetch();

    return () => {
      cancelled = true;
    };
  }, [fetchData]);

  // Polling — only when arena is in a non-terminal state
  useEffect(() => {
    if (!arenaState || TERMINAL_STATES.includes(arenaState.gameState)) {
      return;
    }

    intervalRef.current = setInterval(async () => {
      const gameState = await fetchData();

      // Stop polling if we've reached a terminal state
      if (gameState && TERMINAL_STATES.includes(gameState)) {
        if (intervalRef.current) clearInterval(intervalRef.current);
      }
    }, refreshInterval);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [arenaState?.gameState, fetchData, refreshInterval]);

  const refetch = useCallback(async () => {
    setLoading(true);
    await fetchData();
    setLoading(false);
  }, [fetchData]);

  return {
    arenaState,
    loading,
    error,
    refetch,
  };
};
