import { toArenaState, type ArenaState } from "../useArenaState";
import type { ArenaStateFromContract } from "@/shared-d/types/contract-state";

function baseResponse(
  overrides: Partial<ArenaStateFromContract> = {},
): ArenaStateFromContract {
  return {
    arenaId: "arena-1",
    contractArenaState: {
      survivors: 0,
      capacity: 10,
      round: 1,
      stakes: 0n,
      payouts: 0n,
    },
    contractUserState: { active: false, won: false },
    gameState: null,
    entryFee: null,
    playerCount: 0,
    commitDeadline: null,
    revealDeadline: null,
    ...overrides,
  };
}

describe("toArenaState", () => {
  it("maps gameState 0 to open", () => {
    expect(toArenaState(baseResponse({ gameState: 0 })).status).toBe("open");
  });

  it("maps gameState 1 to round_active", () => {
    expect(toArenaState(baseResponse({ gameState: 1 })).status).toBe("round_active");
  });

  it("maps gameState 3 to cancelled", () => {
    expect(toArenaState(baseResponse({ gameState: 3 })).status).toBe("cancelled");
  });

  it("maps gameState 4 to settled for non-winners", () => {
    expect(
      toArenaState(
        baseResponse({
          gameState: 4,
          contractUserState: { active: false, won: false },
        }),
      ).status,
    ).toBe("settled");
  });

  it("maps gameState 4 to finished for winners", () => {
    expect(
      toArenaState(
        baseResponse({
          gameState: 4,
          contractUserState: { active: false, won: true },
        }),
      ).status,
    ).toBe("finished");
  });

  it("does not let a stale win flag override an active round", () => {
    expect(
      toArenaState(
        baseResponse({
          gameState: 1,
          contractUserState: { active: true, won: true },
        }),
      ).status,
    ).toBe("round_active");
  });

  it("falls back to open for unknown and unavailable game states", () => {
    expect(toArenaState(baseResponse({ gameState: 99 })).status).toBe("open");
    expect(toArenaState(baseResponse({ gameState: null })).status).toBe("open");
  });

  it("maps a null entry fee to zero", () => {
    expect(toArenaState(baseResponse({ entryFee: null })).entryFee).toBe(0);
  });

  it("maps gameState 2 to resolving", () => {
    expect(toArenaState(baseResponse({ gameState: 2 })).status).toBe("resolving");
  });

  it("preserves canonical contract and display fields", () => {
    const response = baseResponse({
      contractArenaState: {
        survivors: 3,
        capacity: 8,
        round: 2,
        stakes: 100_000_000n,
        payouts: 250_000_000n,
      },
      contractUserState: { active: true, won: false },
      entryFee: 100,
      playerCount: 5,
    });
    const state: ArenaState = toArenaState(response);

    expect(state).toMatchObject({
      id: "arena-1",
      survivorsCount: 5,
      maxCapacity: 8,
      isUserIn: true,
      currentRound: 2,
      entryFee: 100,
      playerCount: 5,
      stakes: 100_000_000n,
      payouts: 250_000_000n,
    });
  });
});

describe("terminal states", () => {
  it("does not derive a joinable state for cancelled arenas", () => {
    expect(toArenaState(baseResponse({ gameState: 3 })).status).toBe("cancelled");
  });

  it("does not derive a joinable state for settled arenas", () => {
    expect(toArenaState(baseResponse({ gameState: 4 })).status).toBe("settled");
  });
});
