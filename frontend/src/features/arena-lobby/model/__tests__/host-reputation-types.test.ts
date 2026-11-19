import { describe, expect, it } from "vitest";
import {
  computeReputationScore,
  computeReputationTier,
  MIN_SAMPLE_SIZE,
  type HostReputationBreakdown,
} from "./host-reputation-types";

const perfectBreakdown: HostReputationBreakdown = {
  completionRate: 1,
  cancellationRate: 0,
  avgStartDelaySeconds: 0,
  keeperTakeovers: 0,
  disputeCount: 0,
  arenasHosted: 20,
};

describe("computeReputationScore", () => {
  it("returns null when below minimum sample size", () => {
    expect(
      computeReputationScore({ ...perfectBreakdown, arenasHosted: MIN_SAMPLE_SIZE - 1 })
    ).toBeNull();
  });

  it("returns 100 for a perfect host", () => {
    expect(computeReputationScore(perfectBreakdown)).toBe(100);
  });

  it("penalises high cancellation via completion rate", () => {
    const score = computeReputationScore({ ...perfectBreakdown, completionRate: 0.5 });
    expect(score).toBeLessThan(80);
  });

  it("penalises long start delays", () => {
    const score = computeReputationScore({ ...perfectBreakdown, avgStartDelaySeconds: 3600 });
    expect(score).toBeLessThan(90);
  });

  it("penalises keeper takeovers", () => {
    const score = computeReputationScore({ ...perfectBreakdown, keeperTakeovers: 5 });
    expect(score).toBeLessThan(100);
  });

  it("never returns a score below 0", () => {
    const score = computeReputationScore({
      ...perfectBreakdown,
      completionRate: 0,
      avgStartDelaySeconds: 100000,
      keeperTakeovers: 100,
      disputeCount: 100,
    });
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("computeReputationTier", () => {
  it("maps null score to unknown", () => {
    expect(computeReputationTier(null)).toBe("unknown");
  });
  it("maps 95 to elite", () => expect(computeReputationTier(95)).toBe("elite"));
  it("maps 75 to trusted", () => expect(computeReputationTier(75)).toBe("trusted"));
  it("maps 55 to new", () => expect(computeReputationTier(55)).toBe("new"));
  it("maps 30 to cautious", () => expect(computeReputationTier(30)).toBe("cautious"));
});
