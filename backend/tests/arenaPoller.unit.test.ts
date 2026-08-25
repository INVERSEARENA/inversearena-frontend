import { computePollDelay } from "../src/cache/arenaPoller";

describe("arena poll retry delay", () => {
  test("uses the normal interval before any failures", () => {
    expect(computePollDelay(0)).toBe(2_500);
  });

  test("backs off exponentially after consecutive failures", () => {
    expect(computePollDelay(1)).toBe(2_500);
    expect(computePollDelay(2)).toBe(5_000);
    expect(computePollDelay(3)).toBe(10_000);
    expect(computePollDelay(4)).toBe(20_000);
  });

  test("caps retry traffic during sustained outages", () => {
    expect(computePollDelay(10)).toBe(60_000);
    expect(computePollDelay(100)).toBe(60_000);
  });
});
