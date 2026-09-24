/**
 * Hook-level coverage for useArenaState's deterministic reconciliation
 * surface (#1385): `reconcile(publicKey)` re-reads the authoritative chain
 * state and replaces the hook's local/optimistic state with it, exposing
 * `lastSyncedAt` so callers can reason about convergence.
 */
import {
  renderHook,
  waitFor,
  act,
} from "@testing-library/react";
import { useArenaState } from "../useArenaState";
import type { ArenaStateResponse } from "@/shared-d/utils/stellar-transactions";

const mockFetchArenaState = jest.fn();

jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  fetchArenaState: (...args: unknown[]) => mockFetchArenaState(...args),
}));

const ARENA_ID = "arena-1";
const USER_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function baseResponse(overrides: Partial<ArenaStateResponse> = {}): ArenaStateResponse {
  return {
    arenaId: ARENA_ID,
    survivorsCount: 8,
    maxCapacity: 10,
    isUserIn: false,
    hasWon: false,
    currentStake: 100,
    potentialPayout: 250,
    roundNumber: 1,
    gameState: 1,
    entryFee: 100,
    playerCount: 8,
    commitDeadline: null,
    revealDeadline: null,
    ...overrides,
  };
}

describe("useArenaState.reconcile", () => {
  beforeEach(() => {
    mockFetchArenaState.mockReset();
    mockFetchArenaState.mockResolvedValue(baseResponse());
  });

  it("exposes lastSyncedAt as null until the first successful read", async () => {
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    expect(result.current.lastSyncedAt).toBeNull();

    await waitFor(() => expect(result.current.lastSyncedAt).not.toBeNull());
    unmount();
  });

  it("converges optimistic state to chain state after confirmation", async () => {
    // Initial poll resolves pre-join (optimistic state says not joined yet).
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ gameState: 1, isUserIn: false }),
    );
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state?.isUserIn).toBe(false);

    // The join transaction confirmed on-chain moments later: reconcile re-reads
    // the chain and deterministically replaces the stale local state.
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ gameState: 1, isUserIn: true }),
    );
    let converged: unknown;
    await act(async () => {
      converged = await result.current.reconcile(USER_KEY);
    });

    expect(converged).toMatchObject({ isUserIn: true });
    expect(result.current.state?.isUserIn).toBe(true);
    expect(result.current.health).toBe("connected");
    expect(result.current.lastSyncedAt).toEqual(expect.any(Number));
    unmount();
  });

  it("converges to winner state after a timeout that later confirms on-chain", async () => {
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ gameState: 1, isUserIn: true, hasWon: false }),
    );
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    mockFetchArenaState.mockResolvedValue(
      baseResponse({ gameState: 4, isUserIn: true, hasWon: true }),
    );
    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });

    expect(result.current.state?.state).toBe("finished");
    expect(result.current.state?.hasWon).toBe(true);
    unmount();
  });

  it("passes the wallet address through so user-scoped fields are populated", async () => {
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.lastSyncedAt).not.toBeNull());

    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });

    expect(mockFetchArenaState).toHaveBeenLastCalledWith(ARENA_ID, USER_KEY);
    unmount();
  });

  it("keeps the last known state and rethrows when a reconcile read fails", async () => {
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ gameState: 1, isUserIn: true }),
    );
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state?.isUserIn).toBe(true));

    mockFetchArenaState.mockRejectedValue(new Error("RPC unreachable"));

    let reconcileError: unknown;
    await act(async () => {
      try {
        await result.current.reconcile(USER_KEY);
      } catch (err) {
        reconcileError = err;
      }
    });

    expect(String((reconcileError as Error).message)).toBe("RPC unreachable");
    expect(result.current.state?.isUserIn).toBe(true);
    unmount();
  });

  it("resolves null and skips the network when no arenaId is configured", async () => {
    const { result, unmount } = renderHook(() => useArenaState(""));

    expect(await result.current.reconcile(USER_KEY)).toBeNull();
    expect(mockFetchArenaState).not.toHaveBeenCalled();
    expect(result.current.lastSyncedAt).toBeNull();
    unmount();
  });
});