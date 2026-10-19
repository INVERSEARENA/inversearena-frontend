"use client";

import { useCallback, useEffect, useRef } from "react";
import { fetchArenaState } from "@/shared-d/utils/stellar-transactions";
import type {
  ArenaState,
  ArenaStateStatus,
  ArenaStateFromContract,
} from "@/shared-d/types/contract-state";
import {
  arenaStore,
  normalizeArenaId,
  useArenaStore,
  type ArenaHealthStatus,
  type ArenaStoreOwner,
  type ArenaRequestToken,
  type ArenaStoreSnapshot,
} from "./arenaStore";

export type { ArenaHealthStatus } from "./arenaStore";
export type {
  ArenaState,
  ArenaStateStatus,
  ArenaStateFromContract,
} from "@/shared-d/types/contract-state";

export interface UseArenaStateReturn {
  state: ArenaState | null;
  health: ArenaHealthStatus;
  lastSyncedAt: number | null;
  reconcile: (publicKey?: string) => Promise<ArenaState | null>;
}

export interface UseArenaStateActionsReturn {
  reconcile: (publicKey?: string) => Promise<ArenaState | null>;
}

const POLL_INTERVAL_MS = 5_000;
const FINISHED_POLL_INTERVAL_MS = 30_000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export function toArenaState(data: ArenaStateFromContract): ArenaState {
  const id = data.arenaId;
  const currentRound = data.contractArenaState.round;
  const isUserIn = data.contractUserState.active;
  const hasWon = data.contractUserState.won;
  const currentStake = Number(data.contractArenaState.stakes) / 10_000_000;
  const potentialPayout = Number(data.contractArenaState.payouts) / 10_000_000;

  return {
    id,
    status: (function mapState(): ArenaStateStatus {
      if (data.gameState === null) return "open";
      if (hasWon && data.gameState === 4) return "finished";
      switch (data.gameState) {
        case 0:
          return "open";
        case 1:
          return "round_active";
        case 2:
          return "resolving";
        case 3:
          return "cancelled";
        case 4:
          return "settled";
        default:
          return "open";
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

function preserveUserState(
  previous: ArenaState | null,
  next: ArenaState,
): ArenaState {
  if (!previous) return next;
  return {
    ...next,
    isUserIn: previous.isUserIn,
    hasWon: previous.hasWon,
    currentStake: previous.currentStake,
    potentialPayout: previous.potentialPayout,
    claimReady: previous.claimReady,
  };
}

async function addClaimReadiness(
  arenaId: string,
  state: ArenaState,
): Promise<ArenaState> {
  if (!state.hasWon) return state;

  try {
    const response = await fetch(
      `/api/payouts/claim-readiness/${encodeURIComponent(arenaId)}`,
    );
    if (!response.ok) return { ...state, claimReady: false };
    const body = (await response.json()) as { ready?: unknown };
    return { ...state, claimReady: body.ready === true };
  } catch {
    return { ...state, claimReady: false };
  }
}

export function useArenaStateActions(arenaId: string): UseArenaStateActionsReturn {
  const normalizedArenaId = normalizeArenaId(arenaId);
  const currentArenaIdRef = useRef(normalizedArenaId);
  const mountedRef = useRef(true);
  const reconcileTokensRef = useRef<Set<ArenaRequestToken>>(new Set());
  currentArenaIdRef.current = normalizedArenaId;

  const reconcile = useCallback(
    async (publicKey?: string): Promise<ArenaState | null> => {
      if (
        !normalizedArenaId ||
        !mountedRef.current ||
        currentArenaIdRef.current !== normalizedArenaId
      ) {
        return null;
      }

      const request = arenaStore.actions.beginRequest(normalizedArenaId);
      reconcileTokensRef.current.add(request);
      try {
        const data = await fetchArenaState(normalizedArenaId, publicKey ?? "");
        if (
          !mountedRef.current ||
          currentArenaIdRef.current !== normalizedArenaId
        ) {
          return null;
        }
        let nextState = toArenaState(data);
        if (nextState.hasWon) {
          nextState = await addClaimReadiness(normalizedArenaId, nextState);
        }
        const applied = arenaStore.actions.resolveRequest(request, nextState);
        return applied ? nextState : null;
      } catch (error) {
        if (
          mountedRef.current &&
          currentArenaIdRef.current === normalizedArenaId
        ) {
          arenaStore.actions.rejectRequest(request, false);
        }
        throw error;
      } finally {
        reconcileTokensRef.current.delete(request);
      }
    },
    [normalizedArenaId],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!normalizedArenaId) {
      return () => {
        mountedRef.current = false;
      };
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pollErrorCount = 0;
    const reconcileTokens = reconcileTokensRef.current;
    const owner: ArenaStoreOwner | null =
      arenaStore.actions.retainArena(normalizedArenaId);

    const schedule = (delay: number): void => {
      if (cancelled) return;
      timeoutId = setTimeout(() => {
        timeoutId = null;
        void poll();
      }, delay);
    };

    async function poll(): Promise<void> {
      if (reconcileTokens.size > 0) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      const request = arenaStore.actions.beginRequest(normalizedArenaId);
      try {
        const data = await fetchArenaState(normalizedArenaId, "");
        if (cancelled || !mountedRef.current) return;

        let nextState = toArenaState(data);
        if (nextState.hasWon) {
          nextState = await addClaimReadiness(normalizedArenaId, nextState);
        }
        if (cancelled || !mountedRef.current) return;

        const stateToApply = preserveUserState(
          arenaStore.getSnapshot().state,
          nextState,
        );
        if (arenaStore.actions.resolveRequest(request, stateToApply)) {
          pollErrorCount = 0;
        }
        schedule(
          nextState.status === "finished"
            ? FINISHED_POLL_INTERVAL_MS
            : POLL_INTERVAL_MS,
        );
      } catch {
        if (cancelled || !mountedRef.current) return;
        if (arenaStore.actions.rejectRequest(request, true)) {
          pollErrorCount += 1;
        }
        pollErrorCount = Math.max(1, pollErrorCount);
        const backoff = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (pollErrorCount - 1),
          MAX_BACKOFF_MS,
        );
        schedule(backoff);
      }
    }

    void poll();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      reconcileTokens.clear();
      arenaStore.actions.releaseArena(owner, normalizedArenaId);
    };
  }, [normalizedArenaId]);

  return { reconcile };
}

export function useArenaState(arenaId: string): UseArenaStateReturn {
  const normalizedArenaId = normalizeArenaId(arenaId);
  const selectState = useCallback(
    (snapshot: ArenaStoreSnapshot) =>
      snapshot.arenaId === normalizedArenaId ? snapshot.state : null,
    [normalizedArenaId],
  );
  const selectHealth = useCallback(
    (snapshot: ArenaStoreSnapshot): ArenaHealthStatus =>
      snapshot.arenaId === normalizedArenaId ? snapshot.health : "connected",
    [normalizedArenaId],
  );
  const selectLastSyncedAt = useCallback(
    (snapshot: ArenaStoreSnapshot) =>
      snapshot.arenaId === normalizedArenaId ? snapshot.lastSyncedAt : null,
    [normalizedArenaId],
  );

  const state = useArenaStore(selectState);
  const health = useArenaStore(selectHealth);
  const lastSyncedAt = useArenaStore(selectLastSyncedAt);
  const { reconcile } = useArenaStateActions(arenaId);

  return { state, health, lastSyncedAt, reconcile };
}
