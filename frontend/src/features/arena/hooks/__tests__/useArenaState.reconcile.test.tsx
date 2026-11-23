import { act, renderHook, waitFor } from "@testing-library/react";
import type { ArenaStateFromContract, PlayerStatus } from "@/shared/lib/stellar/contract-state";
import { useArenaState } from "../useArenaState";
import { resetArenaStore } from "@/features/arena/model/arenaStore";

const mockFetchArenaState = jest.fn();
const mockFetchPlayerStatus = jest.fn();

jest.mock("@/shared/lib/stellar/stellar-transactions", () => ({
  fetchArenaState: (...args: unknown[]) => mockFetchArenaState(...args),
  fetchPlayerStatus: (...args: unknown[]) => mockFetchPlayerStatus(...args),
}));

const ARENA_ID = "arena-1";
const USER_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function baseResponse(
  overrides: Partial<ArenaStateFromContract> = {},
): ArenaStateFromContract {
  return {
    arenaId: ARENA_ID,
    contractArenaState: {
      survivors: 8,
      capacity: 10,
      round: 1,
      stakes: 100_000_000n,
      payouts: 250_000_000n,
    },
    contractUserState: { active: false, won: false },
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
    resetArenaStore();
    mockFetchArenaState.mockReset();
    mockFetchArenaState.mockResolvedValue(baseResponse());
    mockFetchPlayerStatus.mockReset();
    // An arena without `get_player_status` (#1582): legacy user fields apply.
    mockFetchPlayerStatus.mockRejectedValue(new Error("get_player_status unavailable"));
  });

  afterEach(() => {
    resetArenaStore();
  });

  it("publishes a sync timestamp after the first successful read", async () => {
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    expect(result.current.lastSyncedAt).toBeNull();

    await waitFor(() => expect(result.current.lastSyncedAt).not.toBeNull());
    unmount();
  });

  it("converges to authenticated state after confirmation", async () => {
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ contractUserState: { active: false, won: false } }),
    );
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    mockFetchArenaState.mockResolvedValue(
      baseResponse({ contractUserState: { active: true, won: false } }),
    );
    let converged: Awaited<ReturnType<typeof result.current.reconcile>> = null;
    await act(async () => {
      converged = await result.current.reconcile(USER_KEY);
    });

    expect(converged).toMatchObject({ isUserIn: true });
    expect(result.current.state?.isUserIn).toBe(true);
    expect(result.current.health).toBe("connected");
    unmount();
  });

  it("converges to winner state after a delayed confirmation", async () => {
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ contractUserState: { active: true, won: false } }),
    );
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    mockFetchArenaState.mockResolvedValue(
      baseResponse({ gameState: 4, contractUserState: { active: true, won: true } }),
    );
    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });

    expect(result.current.state?.status).toBe("finished");
    expect(result.current.state?.hasWon).toBe(true);
    unmount();
  });

  it("passes the wallet address to the chain boundary", async () => {
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.lastSyncedAt).not.toBeNull());

    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });

    expect(mockFetchArenaState).toHaveBeenLastCalledWith(ARENA_ID, USER_KEY);
    unmount();
  });

  it("retains the last known state and rethrows a reconcile failure", async () => {
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ contractUserState: { active: true, won: false } }),
    );
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state?.isUserIn).toBe(true));

    mockFetchArenaState.mockRejectedValue(new Error("RPC unreachable"));
    let reconcileError: unknown;
    await act(async () => {
      try {
        await result.current.reconcile(USER_KEY);
      } catch (error) {
        reconcileError = error;
      }
    });

    expect(String((reconcileError as Error).message)).toBe("RPC unreachable");
    expect(result.current.state?.isUserIn).toBe(true);
    unmount();
  });

  describe("on-chain player status (#1582)", () => {
    const committedStatus: PlayerStatus = {
      joined: true,
      active: true,
      committed: true,
      revealed: false,
      eliminatedRound: null,
      eliminationReason: "NotEliminated",
      refundClaimed: false,
      winner: false,
      currentRound: 1,
      phase: "Reveal",
    };

    it("gates actions on the status even when the arena-state read fails", async () => {
      mockFetchArenaState.mockRejectedValue(new Error("get_full_state not found"));
      mockFetchPlayerStatus.mockResolvedValue(committedStatus);
      const { result, unmount } = renderHook(() => useArenaState(ARENA_ID, USER_KEY));

      await waitFor(() => expect(result.current.playerStatus).toEqual(committedStatus));
      expect(mockFetchPlayerStatus).toHaveBeenCalledWith(ARENA_ID, USER_KEY);
      expect(result.current.state).toBeNull();
      expect(result.current.actions).toEqual({
        canCommit: false,
        canReveal: true,
        canClaim: false,
        canRefund: false,
      });
      unmount();
    });

    it("disables every action when the status read fails", async () => {
      const { result, unmount } = renderHook(() => useArenaState(ARENA_ID, USER_KEY));
      await waitFor(() => expect(mockFetchPlayerStatus).toHaveBeenCalled());

      expect(result.current.playerStatus).toBeNull();
      expect(Object.values(result.current.actions).some(Boolean)).toBe(false);
      unmount();
    });

    it("re-reads the status on reconcile", async () => {
      mockFetchPlayerStatus.mockResolvedValue({ ...committedStatus, committed: false, phase: "Commit" });
      const { result, unmount } = renderHook(() => useArenaState(ARENA_ID, USER_KEY));
      await waitFor(() => expect(result.current.actions.canCommit).toBe(true));

      mockFetchPlayerStatus.mockResolvedValue(committedStatus);
      await act(async () => {
        await result.current.reconcile(USER_KEY);
      });

      await waitFor(() => expect(result.current.actions.canReveal).toBe(true));
      expect(result.current.actions.canCommit).toBe(false);
      unmount();
    });

    it("reads no status without a player", async () => {
      const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
      await waitFor(() => expect(result.current.state).not.toBeNull());

      expect(mockFetchPlayerStatus).not.toHaveBeenCalled();
      expect(result.current.playerStatus).toBeNull();
      unmount();
    });
  });

  it("skips the network for an empty arena ID", async () => {
    const { result, unmount } = renderHook(() => useArenaState(""));

    await expect(result.current.reconcile(USER_KEY)).resolves.toBeNull();
    expect(mockFetchArenaState).not.toHaveBeenCalled();
    expect(result.current.lastSyncedAt).toBeNull();
    unmount();
  });
});
