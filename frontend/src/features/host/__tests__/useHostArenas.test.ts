import { evaluateHostPreconditions, type HostArena } from "../hooks/useHostArenas";

describe("Host Preconditions Evaluation", () => {
  const baseArena: HostArena = {
    id: "arena-1",
    name: "Test Arena",
    hostAddress: "GHOST123",
    phase: "lobby",
    currentRound: 1,
    totalRounds: 3,
    minPlayers: 3,
    maxPlayers: 10,
    playerCount: 1,
    commitProgress: { committed: 0, total: 1 },
    revealProgress: { revealed: 0, total: 1 },
    deadlines: {},
    paused: false,
  };

  it("blocks start_round when player count is below minPlayers", () => {
    const preconditions = evaluateHostPreconditions(baseArena, 1000);
    expect(preconditions.start_round.allowed).toBe(false);
    expect(preconditions.start_round.reasons).toContain("Not enough players: minimum 3 required");
  });

  it("blocks start_round during grace period countdown", () => {
    const arenaWithGrace: HostArena = {
      ...baseArena,
      playerCount: 4,
      deadlines: { gracePeriodDeadline: 1100 },
    };
    const preconditions = evaluateHostPreconditions(arenaWithGrace, 1000);
    expect(preconditions.start_round.allowed).toBe(false);
    expect(preconditions.start_round.countdownSeconds).toBe(100);
  });

  it("enables resolve_round only when reveal conditions are met", () => {
    const revealArena: HostArena = {
      ...baseArena,
      phase: "revealing",
      revealProgress: { revealed: 3, total: 3 },
    };
    const preconditions = evaluateHostPreconditions(revealArena, 1000);
    expect(preconditions.resolve_round.allowed).toBe(true);
  });
});
