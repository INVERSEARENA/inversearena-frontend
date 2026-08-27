import { redis } from "./redisClient";

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const data = await redis.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  },

  async del(key: string): Promise<void> {
    await redis.del(key);
  },

  /**
   * Deletes keys matching `pattern` using non-blocking SCAN cursor
   * iteration instead of KEYS, which is O(N) over the whole keyspace and
   * blocks Redis's single event-loop thread.
   */
  async delByPattern(pattern: string): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  },
};

/**
 * Cache key builders
 */
export const cacheKeys = {
  oracleYield: () => "oracle:yield",
  arenaStats: (arenaId: string) => `arena:stats:${arenaId}`,
  leaderboard: () => "leaderboard",
};

/**
 * TTLs in seconds
 *
 * oracle:yield  → 60s  (yield rates change slowly)
 * arena:stats   → 15s  (arena state changes with game rounds)
 * leaderboard   → 30s  (updates after games end)
 */
export const cacheTTL = {
  ORACLE_YIELD: 60,
  ARENA_STATS: 15,
  ARENA_ROUNDS: 10,
  LEADERBOARD: 30,
} as const;

/**
 * Explicit cache invalidation (#695).
 *
 * Arena stats are cached for {@link cacheTTL.ARENA_STATS} to absorb the heavy
 * per-arena read under polling load. The TTL alone means a resolved round isn't
 * reflected for up to 15s; invalidating on round resolution drops the entry so
 * the next read recomputes fresh stats immediately.
 */
export async function invalidateArenaStats(arenaId: string): Promise<void> {
  await cache.del(cacheKeys.arenaStats(arenaId));
}
