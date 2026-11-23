import type { PlayerStatus } from "@/shared/lib/stellar/contract-state";
import { NO_ARENA_ACTIONS, deriveArenaActions } from "../arenaActions";

function status(overrides: Partial<PlayerStatus> = {}): PlayerStatus {
  return {
    joined: true,
    active: true,
    committed: false,
    revealed: false,
    eliminatedRound: null,
    eliminationReason: "NotEliminated",
    refundClaimed: false,
    winner: false,
    currentRound: 1,
    phase: "Commit",
    ...overrides,
  };
}

describe("deriveArenaActions", () => {
  it("enables nothing while the status is unknown", () => {
    expect(deriveArenaActions(null)).toEqual(NO_ARENA_ACTIONS);
  });

  it("offers commit once per round to an active player in the commit phase", () => {
    expect(deriveArenaActions(status()).canCommit).toBe(true);
    expect(deriveArenaActions(status({ committed: true })).canCommit).toBe(false);
    expect(deriveArenaActions(status({ active: false })).canCommit).toBe(false);
    expect(deriveArenaActions(status({ phase: "Reveal" })).canCommit).toBe(false);
  });

  it("offers reveal only after a commitment and before a reveal", () => {
    const revealPhase = { phase: "Reveal" as const };
    expect(deriveArenaActions(status({ ...revealPhase, committed: true })).canReveal).toBe(true);
    expect(deriveArenaActions(status(revealPhase)).canReveal).toBe(false);
    expect(
      deriveArenaActions(status({ ...revealPhase, committed: true, revealed: true })).canReveal,
    ).toBe(false);
    expect(deriveArenaActions(status({ committed: true })).canReveal).toBe(false);
  });

  it("offers claim only to the winner of a finished arena", () => {
    expect(deriveArenaActions(status({ phase: "Finished", winner: true })).canClaim).toBe(true);
    expect(deriveArenaActions(status({ phase: "Finished" })).canClaim).toBe(false);
    expect(deriveArenaActions(status({ phase: "Settled", winner: true })).canClaim).toBe(false);
  });

  it("offers a refund once to any joined player of a cancelled arena", () => {
    const cancelled = { phase: "Cancelled" as const };
    expect(deriveArenaActions(status(cancelled)).canRefund).toBe(true);
    expect(
      deriveArenaActions(status({ ...cancelled, active: false, eliminatedRound: 1 })).canRefund,
    ).toBe(true);
    expect(deriveArenaActions(status({ ...cancelled, refundClaimed: true })).canRefund).toBe(false);
    expect(deriveArenaActions(status({ ...cancelled, joined: false, active: false })).canRefund).toBe(
      false,
    );
  });

  it.each(["Lobby", "Intermission"] as const)("enables nothing during %s", (phase) => {
    expect(deriveArenaActions(status({ phase }))).toEqual(NO_ARENA_ACTIONS);
  });
});
