import { act, render, screen } from "@testing-library/react";
import type { ArenaState } from "@/shared-d/types/contract-state";
import { Timer } from "@/components/arena/core/Timer";
import { ArenaStateSummary } from "@/components/arena/ArenaStateSummary";
import {
  arenaStore,
  createArenaStore,
  resetArenaStore,
  selectArenaHealth,
  selectArenaState,
  useArenaStore,
} from "../arenaStore";

const ARENA_ID = "arena-1";

function arenaState(overrides: Partial<ArenaState> = {}): ArenaState {
  return {
    id: ARENA_ID,
    status: "round_active",
    survivorsCount: 4,
    maxCapacity: 10,
    currentRound: 2,
    isUserIn: false,
    hasWon: false,
    currentStake: 1,
    potentialPayout: 2,
    claimReady: false,
    entryFee: 3,
    playerCount: 4,
    survivors: 4,
    capacity: 10,
    round: 2,
    stakes: 10_000_000n,
    payouts: 20_000_000n,
    commitDeadline: null,
    revealDeadline: null,
    ...overrides,
  };
}

describe("arenaStore", () => {
  afterEach(() => {
    resetArenaStore();
    jest.useRealTimers();
  });

  it("publishes frozen snapshots and preserves equivalent state references", () => {
    const store = createArenaStore();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    const owner = store.actions.retainArena(ARENA_ID);
    const firstState = arenaState();
    const firstToken = store.actions.beginRequest(ARENA_ID);

    expect(store.actions.resolveRequest(firstToken, firstState, 100)).toBe(true);
    const firstSnapshot = store.getSnapshot();
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(Object.isFrozen(firstSnapshot.state)).toBe(true);
    expect(firstSnapshot.state).not.toBe(firstState);

    const identicalToken = store.actions.beginRequest(ARENA_ID);
    expect(
      store.actions.resolveRequest(identicalToken, arenaState(), 100),
    ).toBe(true);
    expect(store.getSnapshot()).toBe(firstSnapshot);
    expect(store.getSnapshot().state).toBe(firstSnapshot.state);
    expect(listener).toHaveBeenCalledTimes(2);

    const changedToken = store.actions.beginRequest(ARENA_ID);
    expect(
      store.actions.resolveRequest(
        changedToken,
        arenaState({ playerCount: 5, survivorsCount: 5 }),
        200,
      ),
    ).toBe(true);
    expect(store.getSnapshot()).not.toBe(firstSnapshot);
    expect(store.getSnapshot().state).not.toBe(firstSnapshot.state);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    store.actions.releaseArena(owner, ARENA_ID);
  });

  it("handles empty and zero-valued boundary input without publishing state", () => {
    const store = createArenaStore();
    const listener = jest.fn();
    store.subscribe(listener);

    expect(store.actions.retainArena("   ")).toBeNull();
    expect(store.getSnapshot().arenaId).toBeNull();
    expect(store.getSnapshot().state).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    const owner = store.actions.retainArena(ARENA_ID);
    const token = store.actions.beginRequest(ARENA_ID);
    const boundaryState = arenaState({
      survivorsCount: 0,
      playerCount: 0,
      currentRound: 0,
      currentStake: 0,
      potentialPayout: 0,
      entryFee: 0,
      stakes: 0n,
      payouts: 0n,
    });
    expect(store.actions.resolveRequest(token, boundaryState, 1)).toBe(true);
    expect(store.getSnapshot().state).toMatchObject({
      survivorsCount: 0,
      playerCount: 0,
      currentRound: 0,
      stakes: 0n,
      payouts: 0n,
    });
    store.actions.releaseArena(owner, ARENA_ID);
  });

  it("keeps the last state through failures and resets health after retry", () => {
    const store = createArenaStore();
    const owner = store.actions.retainArena(ARENA_ID);
    const initialToken = store.actions.beginRequest(ARENA_ID);
    const initialState = arenaState();
    store.actions.resolveRequest(initialToken, initialState, 1);
    const stateReference = store.getSnapshot().state;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = store.actions.beginRequest(ARENA_ID);
      expect(store.actions.rejectRequest(token)).toBe(true);
      expect(store.getSnapshot().state).toBe(stateReference);
    }
    expect(store.getSnapshot().health).toBe("offline");

    const retryToken = store.actions.beginRequest(ARENA_ID);
    expect(store.actions.resolveRequest(retryToken, arenaState(), 2)).toBe(true);
    expect(store.getSnapshot().health).toBe("connected");
    expect(store.getSnapshot().state).toBe(stateReference);
    store.actions.releaseArena(owner, ARENA_ID);
  });

  it("rejects stale, concurrent, cross-arena, and mismatched responses", () => {
    const store = createArenaStore();
    const owner = store.actions.retainArena(ARENA_ID);
    const firstToken = store.actions.beginRequest(ARENA_ID);
    const secondToken = store.actions.beginRequest(ARENA_ID);
    const secondState = arenaState({ playerCount: 6, survivorsCount: 6 });

    expect(store.actions.resolveRequest(secondToken, secondState, 2)).toBe(true);
    const resolvedState = store.getSnapshot().state;
    expect(store.actions.resolveRequest(firstToken, arenaState(), 3)).toBe(false);
    expect(store.getSnapshot().state).toBe(resolvedState);

    const mismatchedToken = store.actions.beginRequest(ARENA_ID);
    expect(
      store.actions.resolveRequest(
        mismatchedToken,
        arenaState({ id: "other-arena" }),
        4,
      ),
    ).toBe(false);

    const oldArenaToken = store.actions.beginRequest(ARENA_ID);
    const nextOwner = store.actions.retainArena("arena-2");
    expect(store.actions.resolveRequest(oldArenaToken, arenaState(), 5)).toBe(false);
    expect(store.getSnapshot().arenaId).toBe("arena-2");

    store.actions.releaseArena(owner, ARENA_ID);
    store.actions.releaseArena(nextOwner, "arena-2");
  });
});

describe("arena selector integration", () => {
  const stateRender = jest.fn();
  const healthRender = jest.fn();

  function StatePanel() {
    stateRender();
    const state = useArenaStore(selectArenaState);
    return <span data-testid="state-panel">{state?.playerCount ?? "none"}</span>;
  }

  function HealthPanel() {
    healthRender();
    const health = useArenaStore(selectArenaHealth);
    return <span data-testid="health-panel">{health}</span>;
  }

  beforeEach(() => {
    resetArenaStore();
    stateRender.mockClear();
    healthRender.mockClear();
    jest.useFakeTimers();
    arenaStore.actions.retainArena(ARENA_ID);
    const token = arenaStore.actions.beginRequest(ARENA_ID);
    arenaStore.actions.resolveRequest(token, arenaState(), 1);
  });

  afterEach(() => {
    act(() => {
      resetArenaStore();
    });
    jest.useRealTimers();
  });

  it("keeps timer ticks out of the store and unrelated selectors", () => {
    render(
      <>
        <Timer initialSeconds={2} />
        <ArenaStateSummary />
        <StatePanel />
        <HealthPanel />
      </>,
    );

    const initialStateRenders = stateRender.mock.calls.length;
    const initialHealthRenders = healthRender.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("00:01")).toBeInTheDocument();
    expect(stateRender).toHaveBeenCalledTimes(initialStateRenders);
    expect(healthRender).toHaveBeenCalledTimes(initialHealthRenders);
  });

  it("does not rerender selectors for identical state and only rerenders changed selections", () => {
    render(
      <>
        <ArenaStateSummary />
        <StatePanel />
        <HealthPanel />
      </>,
    );

    const initialStateRenders = stateRender.mock.calls.length;
    const initialHealthRenders = healthRender.mock.calls.length;
    act(() => {
      const identicalToken = arenaStore.actions.beginRequest(ARENA_ID);
      arenaStore.actions.resolveRequest(identicalToken, arenaState(), 2);
    });
    expect(stateRender).toHaveBeenCalledTimes(initialStateRenders);
    expect(healthRender).toHaveBeenCalledTimes(initialHealthRenders);

    act(() => {
      const changedToken = arenaStore.actions.beginRequest(ARENA_ID);
      arenaStore.actions.resolveRequest(
        changedToken,
        arenaState({ playerCount: 7, survivorsCount: 7 }),
        3,
      );
    });
    expect(stateRender).toHaveBeenCalledTimes(initialStateRenders + 1);
    expect(healthRender).toHaveBeenCalledTimes(initialHealthRenders);
    expect(screen.getByTestId("state-panel")).toHaveTextContent("7");
    expect(screen.getByTestId("arena-state-summary")).toHaveTextContent("7/10");
  });
});
