"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ArenaState } from "@/shared-d/types/contract-state";

export type ArenaHealthStatus = "connected" | "degraded" | "offline";

export interface ArenaStoreSnapshot {
  readonly arenaId: string | null;
  readonly state: ArenaState | null;
  readonly health: ArenaHealthStatus;
  readonly lastSyncedAt: number | null;
}

export type ArenaStoreState = ArenaStoreSnapshot;

export type ArenaSelector<T> = (snapshot: ArenaStoreSnapshot) => T;
export type ArenaEquality<T> = (left: T, right: T) => boolean;

export interface ArenaRequestToken {
  readonly arenaId: string;
  readonly generation: number;
  readonly requestId: number;
}

export type ArenaStoreOwner = symbol;

export interface ArenaStoreActions {
  retainArena: (arenaId: string) => ArenaStoreOwner | null;
  releaseArena: (owner: ArenaStoreOwner | null, arenaId: string) => void;
  beginRequest: (arenaId: string) => ArenaRequestToken;
  resolveRequest: (
    token: ArenaRequestToken,
    state: ArenaState,
    syncedAt?: number,
  ) => boolean;
  rejectRequest: (token: ArenaRequestToken, updateHealth?: boolean) => boolean;
  reset: () => void;
}

export interface ArenaStore {
  readonly actions: ArenaStoreActions;
  getSnapshot: () => ArenaStoreSnapshot;
  getState: () => ArenaStoreSnapshot;
  subscribe: (listener: () => void) => () => void;
}

const STATE_KEYS: readonly (keyof ArenaState)[] = [
  "id",
  "status",
  "survivorsCount",
  "maxCapacity",
  "currentRound",
  "isUserIn",
  "hasWon",
  "currentStake",
  "potentialPayout",
  "claimReady",
  "entryFee",
  "playerCount",
  "survivors",
  "capacity",
  "round",
  "stakes",
  "payouts",
  "commitDeadline",
  "revealDeadline",
];

const EMPTY_SNAPSHOT: ArenaStoreSnapshot = Object.freeze({
  arenaId: null,
  state: null,
  health: "connected",
  lastSyncedAt: null,
});

export function normalizeArenaId(arenaId: string): string {
  return typeof arenaId === "string" ? arenaId.trim() : "";
}

function freezeState(state: ArenaState): ArenaState {
  if (Object.isFrozen(state)) return state;
  return Object.freeze({ ...state }) as ArenaState;
}

function freezeSnapshot(snapshot: ArenaStoreSnapshot): ArenaStoreSnapshot {
  return Object.freeze({
    arenaId: snapshot.arenaId,
    state: snapshot.state ? freezeState(snapshot.state) : null,
    health: snapshot.health,
    lastSyncedAt: snapshot.lastSyncedAt,
  });
}

function areArenaStatesEqual(
  left: ArenaState | null,
  right: ArenaState | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return STATE_KEYS.every((key) => Object.is(left[key], right[key]));
}

function snapshotsEqual(
  left: ArenaStoreSnapshot,
  right: ArenaStoreSnapshot,
): boolean {
  return (
    left.arenaId === right.arenaId &&
    left.state === right.state &&
    left.health === right.health &&
    left.lastSyncedAt === right.lastSyncedAt
  );
}

export function shallowEqual<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => Object.is(value, right[index]));
  }

  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      Object.is(leftRecord[key], rightRecord[key]),
  );
}

export function createArenaStore(
  initialSnapshot: ArenaStoreSnapshot = EMPTY_SNAPSHOT,
): ArenaStore {
  let activeArenaId = initialSnapshot.arenaId;
  let snapshot = freezeSnapshot(initialSnapshot);
  let generation = 0;
  let requestSequence = 0;
  let latestRequestId = 0;
  let errorCount = 0;
  const listeners = new Set<() => void>();
  const owners = new Map<string, Set<ArenaStoreOwner>>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const replace = (
    state: ArenaState | null,
    health: ArenaHealthStatus,
    lastSyncedAt: number | null,
    arenaId: string | null,
  ): boolean => {
    const nextSnapshot = freezeSnapshot({
      arenaId,
      state,
      health,
      lastSyncedAt,
    });
    if (snapshotsEqual(snapshot, nextSnapshot)) return false;
    snapshot = nextSnapshot;
    notify();
    return true;
  };

  const activate = (arenaId: string | null): void => {
    const normalizedArenaId = arenaId ? normalizeArenaId(arenaId) : null;
    if (normalizedArenaId === activeArenaId) return;

    activeArenaId = normalizedArenaId;
    generation += 1;
    latestRequestId = ++requestSequence;
    errorCount = 0;
    replace(null, "connected", null, normalizedArenaId);
  };

  const isCurrentRequest = (token: ArenaRequestToken): boolean =>
    token.arenaId === activeArenaId &&
    token.generation === generation &&
    token.requestId === latestRequestId;

  const actions: ArenaStoreActions = {
    retainArena: (arenaId: string): ArenaStoreOwner | null => {
      const normalizedArenaId = normalizeArenaId(arenaId);
      if (!normalizedArenaId) return null;

      activate(normalizedArenaId);
      const owner = Symbol("arena-store-owner");
      const arenaOwners = owners.get(normalizedArenaId) ?? new Set<ArenaStoreOwner>();
      arenaOwners.add(owner);
      owners.set(normalizedArenaId, arenaOwners);
      return owner;
    },

    releaseArena: (owner: ArenaStoreOwner | null, arenaId: string): void => {
      if (!owner) return;
      const normalizedArenaId = normalizeArenaId(arenaId);
      const arenaOwners = owners.get(normalizedArenaId);
      if (!arenaOwners) return;

      arenaOwners.delete(owner);
      if (arenaOwners.size > 0) return;
      owners.delete(normalizedArenaId);

      if (activeArenaId === normalizedArenaId) {
        generation += 1;
        latestRequestId = ++requestSequence;
        errorCount = 0;
        activeArenaId = null;
        replace(null, "connected", null, null);
      }
    },

    beginRequest: (arenaId: string): ArenaRequestToken => {
      const normalizedArenaId = normalizeArenaId(arenaId);
      if (!normalizedArenaId) {
        return Object.freeze({
          arenaId: "",
          generation,
          requestId: ++requestSequence,
        });
      }

      activate(normalizedArenaId);
      const token = Object.freeze({
        arenaId: normalizedArenaId,
        generation,
        requestId: ++requestSequence,
      });
      latestRequestId = token.requestId;
      return token;
    },

    resolveRequest: (
      token: ArenaRequestToken,
      state: ArenaState,
      syncedAt = Date.now(),
    ): boolean => {
      if (
        !isCurrentRequest(token) ||
        state === null ||
        typeof state !== "object" ||
        state.id !== token.arenaId
      ) {
        return false;
      }

      const previousState = snapshot.state;
      const nextState = areArenaStatesEqual(previousState, state)
        ? previousState
        : freezeState(state);
      errorCount = 0;
      replace(nextState, "connected", syncedAt, token.arenaId);
      return true;
    },

    rejectRequest: (
      token: ArenaRequestToken,
      updateHealth = true,
    ): boolean => {
      if (!isCurrentRequest(token) || !updateHealth) return isCurrentRequest(token);

      errorCount += 1;
      const health: ArenaHealthStatus =
        errorCount > 3 ? "offline" : "degraded";
      replace(snapshot.state, health, snapshot.lastSyncedAt, token.arenaId);
      return true;
    },

    reset: (): void => {
      generation += 1;
      latestRequestId = ++requestSequence;
      errorCount = 0;
      activeArenaId = null;
      owners.clear();
      replace(null, "connected", null, null);
    },
  };

  return {
    actions,
    getSnapshot: () => snapshot,
    getState: () => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const arenaStore = createArenaStore();

export const selectArenaId = (snapshot: ArenaStoreSnapshot): string | null =>
  snapshot.arenaId;

export const selectArenaState = (snapshot: ArenaStoreSnapshot): ArenaState | null =>
  snapshot.state;

export const selectArenaHealth = (
  snapshot: ArenaStoreSnapshot,
): ArenaHealthStatus => snapshot.health;

export const selectArenaLastSyncedAt = (
  snapshot: ArenaStoreSnapshot,
): number | null => snapshot.lastSyncedAt;

export function useArenaStore<T>(
  selector: ArenaSelector<T>,
  equalityFn: ArenaEquality<T> = shallowEqual,
): T {
  const selectedRef = useRef<{ value: T } | null>(null);
  const getSelection = useCallback(() => {
    const nextValue = selector(arenaStore.getSnapshot());
    const previous = selectedRef.current;
    if (previous === null || !equalityFn(previous.value, nextValue)) {
      const next = { value: nextValue };
      selectedRef.current = next;
      return next.value;
    }
    return previous.value;
  }, [equalityFn, selector]);

  return useSyncExternalStore(
    arenaStore.subscribe,
    getSelection,
    getSelection,
  );
}

export function useArenaSelector<T>(
  selector: ArenaSelector<T>,
  equalityFn: ArenaEquality<T> = shallowEqual,
): T {
  return useArenaStore(selector, equalityFn);
}

export function useArenaStoreSelector<T>(
  selector: ArenaSelector<T>,
  equalityFn: ArenaEquality<T> = shallowEqual,
): T {
  return useArenaStore(selector, equalityFn);
}

export function resetArenaStore(): void {
  arenaStore.actions.reset();
}
