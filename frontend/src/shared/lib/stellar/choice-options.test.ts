import { getChoiceOptions, leastChosenOptions } from "./choice-options";
describe("minority options", () => {
  it("preserves the binary mode", () => expect(getChoiceOptions(2)).toEqual(["Heads", "Tails"]));
  it("offers the third choice", () => expect(getChoiceOptions(3)).toHaveLength(3));
  it("ignores unchosen options", () => expect(leastChosenOptions([5, 2, 0])).toEqual([1]));
  it("retains tied minority options", () => expect(leastChosenOptions([4, 2, 2])).toEqual([1, 2]));
  it("returns no winner without reveals", () => expect(leastChosenOptions([0, 0, 0])).toEqual([]));
  it("rejects invalid counts", () => expect(() => leastChosenOptions([-1, 2])).toThrow());
});
