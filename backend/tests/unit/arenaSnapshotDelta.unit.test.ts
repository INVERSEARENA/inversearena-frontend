import { buildFieldDelta, preferDelta, applyFieldDelta } from "../../src/cache/arenaSnapshotDelta";

describe("arena snapshot deltas (#1767)", () => {
  const previous = { playerCount: 8, survivorCount: 8, status: "active" };
  const next = { playerCount: 8, survivorCount: 7, status: "active" };

  it("replaces only the fields that changed", () => {
    expect(buildFieldDelta(previous, next)).toEqual({ replace: { survivorCount: 7 } });
  });

  it("applies a delta onto the previous snapshot", () => {
    const delta = buildFieldDelta(previous, next);
    expect(applyFieldDelta(previous, delta)).toEqual(next);
  });

  it("prefers a delta when it is smaller than the snapshot and the snapshot otherwise", () => {
    const delta = buildFieldDelta(previous, next);
    expect(preferDelta(delta, next)).toBe(true);
    expect(preferDelta(next, next)).toBe(false);
  });
});
