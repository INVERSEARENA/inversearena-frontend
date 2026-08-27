/**
 * Tests for toArenaState's on-chain GameState -> UI state mapping (#1151).
 *
 * `ArenaState.state` used to collapse every on-chain GameState variant into
 * just "active" | "finished" (`data.hasWon ? "finished" : "active"`), which
 * meant a cancelled or settled arena displayed as joinable. That specific bug
 * was fixed in #1169 (see the mapState() switch below), but no test verified
 * the mapping — this file is that missing coverage, pinning the current
 * behavior of every GameState value against regression.
 *
 * The on-chain GameState enum (contract/arena/src/types.rs) is, in
 * discriminant order: Open=0, Active=1, Finished=2, Cancelled=3, Settled=4 --
 * there is no on-chain "Resolving" variant. toArenaState's switch labels
 * gameState 2 as "resolving" rather than "finished"/"settled": this is a
 * real, current mismatch between the UI label and the actual on-chain
 * state, found while writing this test and asserted below (not silently
 * papered over) so it's visible rather than accidentally locked in as
 * "correct" by a passing test that never named it.
 */
import { toArenaState, type ArenaState } from "../useArenaState";
import type { ArenaStateResponse } from "@/shared-d/utils/stellar-transactions";

function baseResponse(overrides: Partial<ArenaStateResponse> = {}): ArenaStateResponse {
  return {
    arenaId: "arena-1",
    survivorsCount: 0,
    maxCapacity: 10,
    isUserIn: false,
    hasWon: false,
    currentStake: 0,
    potentialPayout: 0,
    roundNumber: 1,
    gameState: 0,
    entryFee: 100,
    playerCount: 0,
    commitDeadline: null,
    revealDeadline: null,
    ...overrides,
  };
}

describe("toArenaState", () => {
  it("maps gameState 0 to open", () => {
    const state = toArenaState(baseResponse({ gameState: 0 }));
    expect(state.state).toBe("open");
  });

  it("maps gameState 1 to round_active", () => {
    const state = toArenaState(baseResponse({ gameState: 1 }));
    expect(state.state).toBe("round_active");
  });

  it("maps gameState 3 (on-chain Cancelled) to cancelled", () => {
    const state = toArenaState(baseResponse({ gameState: 3 }));
    expect(state.state).toBe("cancelled");
  });

  it("maps gameState 4 (on-chain Settled) to settled when the caller has not won", () => {
    const state = toArenaState(baseResponse({ gameState: 4, hasWon: false }));
    expect(state.state).toBe("settled");
  });

  it("maps gameState 4 to finished when hasWon is true (the winner's own view)", () => {
    const state = toArenaState(baseResponse({ gameState: 4, hasWon: true }));
    expect(state.state).toBe("finished");
  });

  it("does not map to finished on hasWon alone without gameState 4", () => {
    // A stale hasWon flag from a previous round must not override the
    // current on-chain state for anyone but the actual settled winner.
    const state = toArenaState(baseResponse({ gameState: 1, hasWon: true }));
    expect(state.state).toBe("round_active");
  });

  it("falls back to open for an unrecognized gameState value", () => {
    const state = toArenaState(baseResponse({ gameState: 99 }));
    expect(state.state).toBe("open");
  });

  // Documents the mismatch found while writing this coverage: the on-chain
  // GameState enum has no "Resolving" variant (Open=0, Active=1,
  // Finished=2, Cancelled=3, Settled=4) — gameState 2 is actually the
  // contract's Finished state, but toArenaState currently labels it
  // "resolving". This test pins the CURRENT (mismatched) behavior rather
  // than the enum's real meaning, so a future fix reconciling the two is a
  // deliberate, visible change to this test rather than a silent one.
  it("maps gameState 2 to resolving (current behavior — see file header re: on-chain Finished)", () => {
    const state = toArenaState(baseResponse({ gameState: 2 }));
    expect(state.state).toBe("resolving");
  });

  it("passes through every other ArenaStateResponse field unchanged", () => {
    const response = baseResponse({
      survivorsCount: 3,
      maxCapacity: 8,
      isUserIn: true,
      currentStake: 100,
      potentialPayout: 250,
      roundNumber: 2,
      entryFee: 100,
      playerCount: 5,
    });
    const state: ArenaState = toArenaState(response);
    expect(state.id).toBe("arena-1");
    expect(state.survivorsCount).toBe(3);
    expect(state.maxCapacity).toBe(8);
    expect(state.isUserIn).toBe(true);
    expect(state.currentRound).toBe(2);
    expect(state.entryFee).toBe(100);
    expect(state.playerCount).toBe(5);
  });
});

describe("cancelled and settled arenas should not be joinable", () => {
  // No component in this codebase currently consumes useArenaState's output
  // to gate a join button (`useArenaState` has zero importers outside this
  // file as of this writing — the join flow on src/app/arena/page.tsx uses
  // its own separate isConnected/isJoined state, not this hook). The
  // acceptance criterion "the join button should not render when state is
  // cancelled or settled" is therefore asserted here at the level that
  // actually exists today: the derived ArenaState.state value a join-gate
  // would need to check. If/when a component wires this hook to a join
  // button, its own test should assert against the rendered button
  // directly; this is the value-level guarantee that makes such a gate
  // possible to write correctly.
  it("derives a non-open, non-round_active state for a cancelled arena", () => {
    const state = toArenaState(baseResponse({ gameState: 3 }));
    expect(["cancelled"]).toContain(state.state);
    expect(state.state).not.toBe("open");
    expect(state.state).not.toBe("round_active");
  });

  it("derives a non-open, non-round_active state for a settled arena", () => {
    const state = toArenaState(baseResponse({ gameState: 4 }));
    expect(["settled", "finished"]).toContain(state.state);
    expect(state.state).not.toBe("open");
    expect(state.state).not.toBe("round_active");
  });
});
