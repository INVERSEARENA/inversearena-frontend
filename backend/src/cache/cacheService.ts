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

  async delByPattern(pattern: string): Promise<void> {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
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
  LEADERBOARD: 30,
} as const;
