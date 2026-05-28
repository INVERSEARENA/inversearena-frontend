import { jest } from "@jest/globals";

// Mock the redis client so no real connection is needed.
const del = jest.fn(async () => 1);
jest.mock("../src/cache/redisClient", () => ({
  redis: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del,
    keys: jest.fn(async () => []),
  },
}));

import { invalidateArenaStats, cacheKeys } from "../src/cache/cacheService";

describe("invalidateArenaStats (#695)", () => {
  beforeEach(() => del.mockClear());

  it("deletes exactly the arena's stats cache key", async () => {
    await invalidateArenaStats("arena-123");
    expect(del).toHaveBeenCalledWith(cacheKeys.arenaStats("arena-123"));
    expect(del).toHaveBeenCalledWith("arena:stats:arena-123");
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("scopes invalidation to the given arena only", async () => {
    await invalidateArenaStats("a");
    expect(del).toHaveBeenCalledWith("arena:stats:a");
    expect(del).not.toHaveBeenCalledWith("arena:stats:b");
  });
});
