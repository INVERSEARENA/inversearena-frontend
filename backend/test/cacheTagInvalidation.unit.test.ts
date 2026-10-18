const mockStore = new Map<string, string>();
const mockSetStore = new Map<string, Set<string>>();

const mockRedis = {
  get: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  mget: jest.fn(async (...keys: string[]) => keys.map((k) => mockStore.get(k) ?? null)),
  set: jest.fn(async (key: string, val: string) => {
    mockStore.set(key, val);
    return "OK";
  }),
  del: jest.fn(async (...keys: string[]) => {
    let count = 0;
    for (const k of keys) {
      if (mockStore.delete(k)) count++;
      if (mockSetStore.delete(k)) count++;
    }
    return count;
  }),
  incr: jest.fn(async (key: string) => {
    const val = Number(mockStore.get(key) ?? 0) + 1;
    mockStore.set(key, String(val));
    return val;
  }),
  sadd: jest.fn(async (key: string, member: string) => {
    if (!mockSetStore.has(key)) mockSetStore.set(key, new Set());
    mockSetStore.get(key)!.add(member);
    return 1;
  }),
  smembers: jest.fn(async (key: string) => {
    const s = mockSetStore.get(key);
    return s ? Array.from(s) : [];
  }),
  expire: jest.fn(async () => 1),
  pipeline: jest.fn(() => {
    const operations: Array<() => Promise<unknown>> = [];
    const pipe = {
      set: (key: string, val: string, _mode?: string, _ttl?: number) => {
        operations.push(async () => {
          mockStore.set(key, val);
          return "OK";
        });
        return pipe;
      },
      sadd: (key: string, member: string) => {
        operations.push(async () => {
          if (!mockSetStore.has(key)) mockSetStore.set(key, new Set());
          mockSetStore.get(key)!.add(member);
          return 1;
        });
        return pipe;
      },
      expire: (_key: string, _ttl: number) => {
        operations.push(async () => 1);
        return pipe;
      },
      exec: async () => {
        const results = [];
        for (const op of operations) {
          results.push([null, await op()]);
        }
        return results;
      },
    };
    return pipe;
  }),
  on: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock("../src/cache/redisClient", () => ({
  redis: mockRedis,
}));

import {
  cache,
  CacheKeys,
  tags,
  invalidateArena,
  invalidateRound,
  invalidateUser,
  _resetNetworkIdentityForTest,
} from "../src/cache/cacheService";
import { cacheRequestsTotal } from "../utils/metrics";

describe("Cache Typed Key Registry and Tag Invalidation", () => {
  beforeEach(() => {
    mockStore.clear();
    mockSetStore.clear();
    jest.clearAllMocks();
    _resetNetworkIdentityForTest();
  });

  describe("Typed Key Registry", () => {
    it("builds consistent typed keys with appropriate namespaces and tags", () => {
      const statsDesc = CacheKeys.arena.stats("arena-100");
      expect(statsDesc.key).toContain("stats:arena-100");
      expect(statsDesc.namespace).toBe("arena_stats");
      expect(statsDesc.tags).toEqual(["arena:arena-100"]);

      const roundsDesc = CacheKeys.arena.rounds("arena-100", 10, "cursor-1");
      expect(roundsDesc.key).toBe("arena:rounds:arena-100:10:cursor-1");
      expect(roundsDesc.namespace).toBe("arena_rounds");
      expect(roundsDesc.tags).toEqual(["arena:arena-100"]);

      const healthDesc = CacheKeys.arena.health("arena-100");
      expect(healthDesc.key).toBe("arena:health:arena-100");
      expect(healthDesc.namespace).toBe("arena_health");
      expect(healthDesc.tags).toEqual(["arena:arena-100"]);

      const proofDesc = CacheKeys.round.proofBundle("round-42");
      expect(proofDesc.key).toBe("round:proof-bundle:round-42");
      expect(proofDesc.namespace).toBe("round_proof_bundle");
      expect(proofDesc.tags).toEqual(["round:round-42"]);

      const userDesc = CacheKeys.user.profile("user-99");
      expect(userDesc.key).toBe("user:profile:user-99");
      expect(userDesc.namespace).toBe("user_profile");
      expect(userDesc.tags).toEqual(["user:user-99"]);

      const poolDesc = CacheKeys.pool.eliminations("pool-5", 50, "0");
      expect(poolDesc.key).toBe("pool:eliminations:pool-5:50:0");
      expect(poolDesc.namespace).toBe("pool_eliminations");
      expect(poolDesc.tags).toEqual(["pool:pool-5", "arena:pool-5"]);
    });
  });

  describe("Multi-Key Fan-Out Invalidation", () => {
    it("invalidates all keys associated with an arena without affecting other arenas", async () => {
      const a1Stats = CacheKeys.arena.stats("arena-1");
      const a1Rounds = CacheKeys.arena.rounds("arena-1");
      const a1Health = CacheKeys.arena.health("arena-1");

      const a2Stats = CacheKeys.arena.stats("arena-2");
      const a2Health = CacheKeys.arena.health("arena-2");

      // Set entries for both arenas
      await cache.set(a1Stats, { playerCount: 10 }, 300);
      await cache.set(a1Rounds, [{ roundId: "r1" }], 300);
      await cache.set(a1Health, { status: "healthy" }, 300);

      await cache.set(a2Stats, { playerCount: 50 }, 300);
      await cache.set(a2Health, { status: "degraded" }, 300);

      // Verify all are readable
      expect(await cache.get(a1Stats)).toEqual({ playerCount: 10 });
      expect(await cache.get(a1Rounds)).toEqual([{ roundId: "r1" }]);
      expect(await cache.get(a1Health)).toEqual({ status: "healthy" });
      expect(await cache.get(a2Stats)).toEqual({ playerCount: 50 });
      expect(await cache.get(a2Health)).toEqual({ status: "degraded" });

      // Invalidate arena-1
      await invalidateArena("arena-1");

      // Verify arena-1 keys are now misses (null)
      expect(await cache.get(a1Stats)).toBeNull();
      expect(await cache.get(a1Rounds)).toBeNull();
      expect(await cache.get(a1Health)).toBeNull();

      // Verify arena-2 keys are preserved
      expect(await cache.get(a2Stats)).toEqual({ playerCount: 50 });
      expect(await cache.get(a2Health)).toEqual({ status: "degraded" });
    });

    it("invalidates round and user keys correctly", async () => {
      const rDesc = CacheKeys.round.proofBundle("round-xyz");
      const uDesc = CacheKeys.user.profile("user-abc");

      await cache.set(rDesc, { proof: "valid-zk-proof" }, 300);
      await cache.set(uDesc, { username: "alice" }, 300);

      expect(await cache.get(rDesc)).toEqual({ proof: "valid-zk-proof" });
      expect(await cache.get(uDesc)).toEqual({ username: "alice" });

      await invalidateRound("round-xyz");
      expect(await cache.get(rDesc)).toBeNull();
      expect(await cache.get(uDesc)).toEqual({ username: "alice" });

      await invalidateUser("user-abc");
      expect(await cache.get(uDesc)).toBeNull();
    });
  });

  describe("Versioned Namespace Resilience against Tag Set Eviction", () => {
    it("drops stale keys when tag set is evicted by Redis under memory pressure", async () => {
      const desc = CacheKeys.arena.stats("arena-evict-test");
      await cache.set(desc, { score: 999 }, 300);

      expect(await cache.get(desc)).toEqual({ score: 999 });

      // Simulate Redis LRU memory pressure: tag set member key is evicted
      mockSetStore.delete(`tag:keys:${tags.arena("arena-evict-test")}`);

      // Now invalidate the tag. Because the tag set was evicted, smembers returns [],
      // but the version counter `tag:ver:arena:arena-evict-test` is incremented.
      await invalidateArena("arena-evict-test");

      // Read the key: checkTagsStale should detect that the recorded version (0)
      // is less than the current tag version (1), evict the key, and return null.
      const result = await cache.get(desc);
      expect(result).toBeNull();

      // The key itself should also have been deleted from store
      expect(mockStore.has(desc.key)).toBe(false);
    });
  });

  describe("Hit and Miss Metrics per Namespace", () => {
    it("records hit and miss metrics with proper namespace labels", async () => {
      const incSpy = jest.spyOn(cacheRequestsTotal, "inc");

      const desc = CacheKeys.arena.stats("arena-metrics");

      // Cache miss initially
      const missResult = await cache.get(desc);
      expect(missResult).toBeNull();
      expect(incSpy).toHaveBeenCalledWith({ namespace: "arena_stats", result: "miss" });

      // Populate cache
      await cache.set(desc, { test: 123 }, 300);

      // Cache hit
      const hitResult = await cache.get(desc);
      expect(hitResult).toEqual({ test: 123 });
      expect(incSpy).toHaveBeenCalledWith({ namespace: "arena_stats", result: "hit" });

      incSpy.mockRestore();
    });
  });
});
