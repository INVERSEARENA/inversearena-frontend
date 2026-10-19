import { test, describe } from "node:test";
import assert from "node:assert";
import { computePollDelay } from "../src/cache/arenaPoller";

describe("arena poll retry delay", () => {
  test("uses the normal interval before any failures", () => {
    assert.strictEqual(computePollDelay(0), 2_500);
  });

  test("backs off exponentially after consecutive failures", () => {
    const delay1 = computePollDelay(1);
    assert.ok(delay1 >= 2_500 && delay1 <= 2_875, `delay1 ${delay1} out of range`);

    const delay2 = computePollDelay(2);
    assert.ok(delay2 >= 5_000 && delay2 <= 5_750, `delay2 ${delay2} out of range`);

    const delay3 = computePollDelay(3);
    assert.ok(delay3 >= 10_000 && delay3 <= 11_500, `delay3 ${delay3} out of range`);

    const delay4 = computePollDelay(4);
    assert.ok(delay4 >= 20_000 && delay4 <= 23_000, `delay4 ${delay4} out of range`);
  });

  test("caps retry traffic during sustained outages", () => {
    assert.strictEqual(computePollDelay(10), 60_000);
    assert.strictEqual(computePollDelay(100), 60_000);
  });
});


