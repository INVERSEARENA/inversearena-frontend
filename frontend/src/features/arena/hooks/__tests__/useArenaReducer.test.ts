/**
 * Tests for the phase-driven arena state machine (#1605).
 */

import {
  arenaReducer,
  initialArenaState,
  canShowCommitButton,
  canShowRevealButton,
  canShowClaimButton,
  type ArenaState,
  type ChainStatePayload,
} from "../useArenaReducer";

const BASE = initialArenaState;

describe("arenaReducer — phase transitions", () => {
  it("starts in idle", () => {
    expect(BASE.phase).toBe("idle");
  });

  it("idle → committing on BEGIN_COMMIT", () => {
    const s = arenaReducer(BASE, { type: "BEGIN_COMMIT" });
    expect(s.phase).toBe("committing");
  });

  it("committing → committed on COMMIT_CONFIRMED", () => {
    const s0 = arenaReducer(BASE, { type: "BEGIN_COMMIT" });
    const s1 = arenaReducer(s0, { type: "COMMIT_CONFIRMED" });
    expect(s1.phase).toBe("committed");
    expect(s1.hasCommittedForRound).toBe(true);
  });

  it("committed → revealing on BEGIN_REVEAL", () => {
    const s0: ArenaState = { ...BASE, phase: "committed", hasCommittedForRound: true };
    const s1 = arenaReducer(s0, { type: "BEGIN_REVEAL" });
    expect(s1.phase).toBe("revealing");
  });

  it("revealing → revealed on REVEAL_CONFIRMED", () => {
    const s0: ArenaState = { ...BASE, phase: "revealing" };
    const s1 = arenaReducer(s0, { type: "REVEAL_CONFIRMED" });
    expect(s1.phase).toBe("revealed");
    expect(s1.hasCommittedForRound).toBe(false);
  });

  it("resolved → winner on WINNER_DECLARED", () => {
    const s0: ArenaState = { ...BASE, phase: "resolved" };
    const s1 = arenaReducer(s0, { type: "WINNER_DECLARED" });
    expect(s1.phase).toBe("winner");
    expect(s1.hasWon).toBe(true);
    expect(s1.userStatus).toBe("WINNER!");
  });

  it("resolved → eliminated on ELIMINATED", () => {
    const s0: ArenaState = { ...BASE, phase: "resolved" };
    const s1 = arenaReducer(s0, { type: "ELIMINATED" });
    expect(s1.phase).toBe("eliminated");
  });

  it("ignores invalid transitions — cannot go from idle to revealed", () => {
    const s = arenaReducer(BASE, { type: "REVEAL_CONFIRMED" });
    expect(s.phase).toBe("idle");
  });

  it("ignores invalid transitions — cannot skip commit to claim", () => {
    const s = arenaReducer(BASE, { type: "COMMIT_CONFIRMED" });
    // committing is required before committed — state unchanged
    expect(s.phase).toBe("idle");
  });
});

describe("arenaReducer — COMMIT_TIME_EXPIRED", () => {
  it("sets commitTimeExpired and advances roundPhase to reveal", () => {
    const s = arenaReducer(BASE, { type: "COMMIT_TIME_EXPIRED" });
    expect(s.commitTimeExpired).toBe(true);
    expect(s.roundPhase).toBe("reveal");
  });

  it("returns to idle phase when player never committed", () => {
    const s = arenaReducer({ ...BASE, hasCommittedForRound: false }, { type: "COMMIT_TIME_EXPIRED" });
    expect(s.phase).toBe("idle");
  });

  it("keeps committed phase when player already committed", () => {
    const s = arenaReducer({ ...BASE, phase: "committed", hasCommittedForRound: true }, { type: "COMMIT_TIME_EXPIRED" });
    expect(s.phase).toBe("committed");
  });
});

describe("arenaReducer — ROUND_ADVANCED", () => {
  it("resets all round-scoped state", () => {
    const after: ArenaState = { ...BASE, phase: "committed", roundPhase: "reveal", selectedChoice: "heads", commitTimeExpired: true, hasCommittedForRound: true };
    const s = arenaReducer(after, { type: "ROUND_ADVANCED", roundNumber: 2 });
    expect(s.phase).toBe("idle");
    expect(s.roundPhase).toBe("commit");
    expect(s.selectedChoice).toBeNull();
    expect(s.commitTimeExpired).toBe(false);
    expect(s.hasCommittedForRound).toBe(false);
    expect(s.currentRound).toBe(2);
  });
});

describe("arenaReducer — CHAIN_STATE_LOADED", () => {
  const payload: ChainStatePayload = {
    isUserIn: true,
    hasWon: false,
    survivorsCount: 64,
    maxCapacity: 128,
    currentStake: 5000,
    potentialPayout: 10000,
    entryFee: 100,
    playerCount: 128,
    currentRound: 3,
  };

  it("updates survivors, stakes, and round from chain payload", () => {
    const s = arenaReducer(BASE, { type: "CHAIN_STATE_LOADED", payload });
    expect(s.survivors.current).toBe(64);
    expect(s.currentRound).toBe(3);
    expect(s.entryFee).toBe(100);
    expect(s.isJoined).toBe(true);
  });

  it("transitions to winner phase when chain reports hasWon", () => {
    const s = arenaReducer(BASE, { type: "CHAIN_STATE_LOADED", payload: { ...payload, hasWon: true } });
    expect(s.phase).toBe("winner");
    expect(s.hasWon).toBe(true);
  });
});

describe("derived selectors", () => {
  it("canShowCommitButton — true in idle/commit with a choice and no expiry", () => {
    const s: ArenaState = { ...BASE, phase: "idle", roundPhase: "commit", selectedChoice: "heads", commitTimeExpired: false };
    expect(canShowCommitButton(s)).toBe(true);
  });

  it("canShowCommitButton — false when time expired", () => {
    const s: ArenaState = { ...BASE, phase: "idle", roundPhase: "commit", selectedChoice: "heads", commitTimeExpired: true };
    expect(canShowCommitButton(s)).toBe(false);
  });

  it("canShowCommitButton — false when already committed", () => {
    const s: ArenaState = { ...BASE, phase: "committed", selectedChoice: "heads" };
    expect(canShowCommitButton(s)).toBe(false);
  });

  it("canShowRevealButton — true when committed and hasCommittedForRound", () => {
    const s: ArenaState = { ...BASE, phase: "committed", hasCommittedForRound: true };
    expect(canShowRevealButton(s)).toBe(true);
  });

  it("canShowRevealButton — false without a commitment", () => {
    const s: ArenaState = { ...BASE, phase: "committed", hasCommittedForRound: false };
    expect(canShowRevealButton(s)).toBe(false);
  });

  it("canShowClaimButton — true in winner phase with claimReady", () => {
    const s: ArenaState = { ...BASE, phase: "winner", hasWon: true, claimReady: true };
    expect(canShowClaimButton(s)).toBe(true);
  });

  it("canShowClaimButton — false without claimReady", () => {
    const s: ArenaState = { ...BASE, phase: "winner", hasWon: true, claimReady: false };
    expect(canShowClaimButton(s)).toBe(false);
  });
});
