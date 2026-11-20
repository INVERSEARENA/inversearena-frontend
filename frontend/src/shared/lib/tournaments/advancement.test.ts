import { calculateAdvancement, isNoShow } from "./advancement";

describe("tournament advancement", () => {
  it("advances unique winners from settled qualifiers", () => {
    expect(calculateAdvancement([
      { arenaId: "a", status: "settled", winners: ["G1"] },
      { arenaId: "b", status: "settled", winners: ["G2"] },
      { arenaId: "c", status: "settled", winners: ["G1"] },
    ]).advancing).toEqual(["G1", "G2"]);
  });
  it("never advances cancelled, pending or tied qualifiers", () => {
    expect(calculateAdvancement([
      { arenaId: "a", status: "cancelled", winners: ["G1"] },
      { arenaId: "b", status: "pending", winners: [] },
      { arenaId: "c", status: "settled", winners: ["G2", "G3"] },
      { arenaId: "d", status: "settled", winners: [] },
    ])).toEqual({
      advancing: [], pendingArenas: ["b"], cancelledArenas: ["a"], requiresTiebreak: ["c", "d"],
    });
  });
  it("detects no-shows only after invitation deadline", () => {
    expect(isNoShow(true, false, 100, 101)).toBe(true);
    expect(isNoShow(true, true, 100, 101)).toBe(false);
    expect(isNoShow(false, false, 100, 101)).toBe(false);
    expect(isNoShow(true, false, 100, 100)).toBe(false);
  });
});
