import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ArenaStateFromContract } from "@/shared-d/types/contract-state";
import {
  resetArenaStore,
  selectArenaState,
  useArenaStore,
} from "../arenaStore";
import {
  useArenaState,
  useArenaStateActions,
} from "../useArenaState";

const mockFetchArenaState = jest.fn();

jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  fetchArenaState: (...args: unknown[]) => mockFetchArenaState(...args),
}));

const ARENA_ID = "arena-1";
const USER_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function contractState(
  overrides: Partial<ArenaStateFromContract> = {},
): ArenaStateFromContract {
  return {
    arenaId: ARENA_ID,
    contractArenaState: {
      survivors: 4,
      capacity: 10,
      round: 2,
      stakes: 10_000_000n,
      payouts: 20_000_000n,
    },
    contractUserState: { active: false, won: false },
    gameState: 1,
    entryFee: 3,
    playerCount: 4,
    commitDeadline: null,
    revealDeadline: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useArenaState store integration", () => {
  beforeEach(() => {
    resetArenaStore();
    mockFetchArenaState.mockReset();
  });

  afterEach(() => {
    resetArenaStore();
    jest.useRealTimers();
  });

  it("keeps the existing normal polling and reconciliation surface", async () => {
    mockFetchArenaState.mockResolvedValue(contractState());
    const { result, rerender, unmount } = renderHook(() => useArenaState(ARENA_ID));
    const reconcile = result.current.reconcile;
    rerender();
    expect(result.current.reconcile).toBe(reconcile);

    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.health).toBe("connected");
    expect(result.current.lastSyncedAt).toEqual(expect.any(Number));
    expect(mockFetchArenaState).toHaveBeenCalledWith(ARENA_ID, "");

    mockFetchArenaState.mockResolvedValue(
      contractState({
        contractUserState: { active: true, won: false },
      }),
    );
    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });
    expect(result.current.state?.isUserIn).toBe(true);
    expect(mockFetchArenaState).toHaveBeenLastCalledWith(ARENA_ID, USER_KEY);
    unmount();
  });

  it("skips network work for an empty arena input", async () => {
    const { result, unmount } = renderHook(() => useArenaState("   "));

    expect(result.current.state).toBeNull();
    expect(result.current.lastSyncedAt).toBeNull();
    await act(async () => {
      await expect(result.current.reconcile(USER_KEY)).resolves.toBeNull();
    });
    expect(mockFetchArenaState).not.toHaveBeenCalled();
    unmount();
  });

  it("keeps an invalid configured arena in a safe retry state", async () => {
    mockFetchArenaState.mockRejectedValue(new Error("invalid arena"));
    const { result, unmount } = renderHook(() => useArenaState("not-an-arena"));

    await waitFor(() => expect(result.current.health).toBe("degraded"));
    expect(result.current.state).toBeNull();
    unmount();
  });

  it("does not let an older concurrent response overwrite a newer reconcile", async () => {
    const firstRead = deferred<ArenaStateFromContract>();
    const secondRead = deferred<ArenaStateFromContract>();
    mockFetchArenaState
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);

    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(mockFetchArenaState).toHaveBeenCalledTimes(1));

    let reconcilePromise!: Promise<unknown>;
    await act(async () => {
      reconcilePromise = result.current.reconcile(USER_KEY);
      await Promise.resolve();
    });
    expect(mockFetchArenaState).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRead.resolve(
        contractState({
          contractUserState: { active: true, won: false },
        }),
      );
      await reconcilePromise;
    });
    expect(result.current.state?.isUserIn).toBe(true);

    await act(async () => {
      firstRead.resolve(contractState());
      await Promise.resolve();
    });
    expect(result.current.state?.isUserIn).toBe(true);
    unmount();
  });

  it("retains the previous state when a retry fails and recovers on success", async () => {
    jest.useFakeTimers();
    mockFetchArenaState
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValueOnce(contractState({ playerCount: 6 }));

    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.health).toBe("degraded");
    expect(result.current.state).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state?.playerCount).toBe(6);
    expect(result.current.health).toBe("connected");
    unmount();
  });

  it("keeps the live-page controller isolated from selector-only panels", async () => {
    const parentRender = jest.fn();
    mockFetchArenaState.mockResolvedValue(contractState());

    function LivePageBoundary() {
      parentRender();
      const { reconcile } = useArenaStateActions(ARENA_ID);
      return (
        <button
          type="button"
          onClick={() => void reconcile(USER_KEY)}
        >
          reconcile
        </button>
      );
    }

    function StatePanel() {
      const state = useArenaStore(selectArenaState);
      return <span data-testid="live-state">{state?.playerCount ?? "none"}</span>;
    }

    render(
      <>
        <LivePageBoundary />
        <StatePanel />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("live-state")).toHaveTextContent("4"));
    const initialParentRenders = parentRender.mock.calls.length;

    mockFetchArenaState.mockResolvedValue(contractState({ playerCount: 6 }));
    await act(async () => {
      screen.getByRole("button", { name: "reconcile" }).click();
    });

    await waitFor(() => expect(screen.getByTestId("live-state")).toHaveTextContent("6"));
    expect(parentRender).toHaveBeenCalledTimes(initialParentRenders);
  });
});
