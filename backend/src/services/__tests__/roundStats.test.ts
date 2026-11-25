import {
  MIN_CONFIDENT_SAMPLE,
  applyRound,
  applyRounds,
  eliminationCurve,
  emptyStats,
  minorityDistribution,
  minoritySide,
  rejectionReason,
  sizeBucketOf,
  survivalHeatmap,
  wilsonInterval,
  type RoundOutcome,
} from "../roundStats";

const round = (over: Partial<RoundOutcome> = {}): RoundOutcome => ({
  arenaId: "a1",
  roundNumber: 1,
  state: "RESOLVED",
  players: 10,
  headsVotes: 4,
  tailsVotes: 6,
  survivors: 4,
  ...over,
});

describe("minoritySide", () => {
  it("is the side with fewer votes", () => {
    expect(minoritySide(3, 7)).toBe("heads");
    expect(minoritySide(7, 3)).toBe("tails");
  });
  it("reports a tie, and null when nobody voted", () => {
    expect(minoritySide(5, 5)).toBe("tie");
    expect(minoritySide(0, 0)).toBeNull();
  });
  it("treats a one-sided round as having the empty side as minority", () => {
    expect(minoritySide(0, 8)).toBe("heads");
  });
});

describe("sizeBucketOf", () => {
  it.each([
    [2, "2-4"], [4, "2-4"], [5, "5-9"], [9, "5-9"], [10, "10-24"], [24, "10-24"], [25, "25+"], [500, "25+"],
  ])("puts %i players in %s", (n, bucket) => expect(sizeBucketOf(n)).toBe(bucket));
  it("has no bucket for fewer than two players", () => {
    expect(sizeBucketOf(1)).toBeNull();
    expect(sizeBucketOf(0)).toBeNull();
  });
});

describe("rejectionReason", () => {
  it("accepts a finalised round", () => {
    expect(rejectionReason(round(), 10)).toBeNull();
    expect(rejectionReason(round({ state: "SETTLED" }), 10)).toBeNull();
  });
  it("never counts rounds that are still open", () => {
    expect(rejectionReason(round({ state: "OPEN" }), 10)).toMatch(/not finalised/);
    expect(rejectionReason(round({ state: "CLOSED" }), 10)).toMatch(/not finalised/);
  });
  it("excludes cancelled arenas", () => {
    expect(rejectionReason(round({ arenaCancelled: true }), 10)).toMatch(/cancelled/);
  });
  it("rejects inconsistent counts", () => {
    expect(rejectionReason(round({ survivors: 11 }), 10)).toMatch(/survivors/);
    expect(rejectionReason(round({ headsVotes: 8, tailsVotes: 8 }), 10)).toMatch(/votes/);
    expect(rejectionReason(round({ players: -1 }), 10)).toMatch(/negative/);
    expect(rejectionReason(round({ roundNumber: 0 }), 10)).toMatch(/round number/);
  });
});

describe("applyRound", () => {
  it("counts a finalised round in its size bucket and round number", () => {
    const stats = applyRound(emptyStats(), round(), 10);
    expect(stats.cells["10-24|1"]).toEqual({
      rounds: 1, playersIn: 10, eliminated: 6, minorityHeads: 1, minorityTails: 0, ties: 0, zeroSurvivor: 0,
    });
  });

  it("is idempotent, so a replayed resolution does not double count", () => {
    const once = applyRound(emptyStats(), round(), 10);
    const twice = applyRound(once, round(), 10);
    expect(twice).toBe(once);
  });

  it("does not mutate its input", () => {
    const before = emptyStats();
    applyRound(before, round(), 10);
    expect(before).toEqual({ cells: {}, seen: [] });
  });

  it("ignores open and cancelled rounds", () => {
    const base = emptyStats();
    expect(applyRound(base, round({ state: "OPEN" }), 10)).toBe(base);
    expect(applyRound(base, round({ arenaCancelled: true }), 10)).toBe(base);
  });

  it("counts ties and zero-survivor rounds", () => {
    const stats = applyRounds(emptyStats(), [
      { round: round({ roundNumber: 2, headsVotes: 5, tailsVotes: 5, survivors: 0 }), arenaSize: 10 },
    ]);
    expect(stats.cells["10-24|2"]).toMatchObject({ ties: 1, zeroSurvivor: 1, eliminated: 10, minorityHeads: 0 });
  });
});

describe("aggregation over fixtures", () => {
  // Arena a1 (10 players): r1 4H/6T -> 4 survive, r2 2H/2T tie -> 0... use 4 players
  // Arena a2 (12 players): r1 7H/5T -> 5 survive
  // Arena a3 (3 players): r1 1H/2T -> 1 survive
  const fixtures = [
    { round: round({ arenaId: "a1", roundNumber: 1, players: 10, headsVotes: 4, tailsVotes: 6, survivors: 4 }), arenaSize: 10 },
    { round: round({ arenaId: "a1", roundNumber: 2, players: 4, headsVotes: 2, tailsVotes: 2, survivors: 2 }), arenaSize: 10 },
    { round: round({ arenaId: "a2", roundNumber: 1, players: 12, headsVotes: 7, tailsVotes: 5, survivors: 5 }), arenaSize: 12 },
    { round: round({ arenaId: "a3", roundNumber: 1, players: 3, headsVotes: 1, tailsVotes: 2, survivors: 1 }), arenaSize: 3 },
  ];
  const stats = applyRounds(emptyStats(), fixtures);

  it("computes the minority-side distribution for the platform", () => {
    const d = minorityDistribution(stats);
    expect(d).toMatchObject({ heads: 2, tails: 1, ties: 1, rounds: 4 });
    expect(d.headsShare).toBeCloseTo(2 / 3);
    expect(d.tieRate).toBe(0.25);
  });

  it("filters by size bucket", () => {
    const d = minorityDistribution(stats, { sizeBucket: "10-24" });
    expect(d).toMatchObject({ heads: 1, tails: 1, ties: 1, rounds: 3 });
    expect(minorityDistribution(stats, { sizeBucket: "2-4" })).toMatchObject({ heads: 1, rounds: 1 });
    expect(minorityDistribution(stats, { sizeBucket: "25+" })).toMatchObject({ rounds: 0, headsShare: null, tieRate: null });
  });

  it("builds the elimination curve by round number", () => {
    const curve = eliminationCurve(stats);
    // Round 1: players 10+12+3 = 25, eliminated 6+7+2 = 15. Round 2: players 4, eliminated 2.
    expect(curve.map((p) => p.roundNumber)).toEqual([1, 2]);
    expect(curve[0]).toMatchObject({ rounds: 3 });
    expect(curve[0].eliminationRate).toBeCloseTo(15 / 25);
    expect(curve[1].eliminationRate).toBeCloseTo(0.5);
  });

  it("builds the survival heatmap ordered by size then round", () => {
    const map = survivalHeatmap(stats);
    expect(map.map((c) => `${c.sizeBucket}|${c.roundNumber}`)).toEqual(["2-4|1", "10-24|1", "10-24|2"]);
    expect(map[0].survivalRate).toBeCloseTo(1 / 3);
    expect(map[1].survivalRate).toBeCloseTo(9 / 22);
  });

  it("flags small samples", () => {
    expect(minorityDistribution(stats).confidence).toEqual({ sample: 4, confident: false });
    let big = emptyStats();
    for (let i = 1; i <= MIN_CONFIDENT_SAMPLE; i++) big = applyRound(big, round({ arenaId: `x${i}` }), 10);
    expect(minorityDistribution(big).confidence.confident).toBe(true);
  });

  it("matches a full recomputation when rounds arrive in a different order", () => {
    const reversed = applyRounds(emptyStats(), [...fixtures].reverse());
    expect(reversed.cells).toEqual(stats.cells);
  });
});

describe("wilsonInterval", () => {
  it("is null for an empty sample", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
  it("brackets the observed proportion and stays within 0..1", () => {
    const { low, high } = wilsonInterval(50, 100)!;
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
    const edge = wilsonInterval(10, 10)!;
    expect(edge.high).toBeLessThanOrEqual(1);
    expect(edge.low).toBeGreaterThan(0.6);
  });
  it("narrows as the sample grows", () => {
    const small = wilsonInterval(5, 10)!;
    const large = wilsonInterval(500, 1000)!;
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });
});
