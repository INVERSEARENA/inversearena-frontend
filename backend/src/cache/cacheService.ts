import { redis } from "./redisClient";
import {
  type NetworkIdentity,
  deriveNetworkIdentity,
  parseNetworkPassphrase,
} from "../../../frontend/src/shared-d/utils/identity-value-objects";
import { getStellarConfig } from "../config/stellarConfig";
import { cacheRequestsTotal } from "../utils/metrics";

/**
 * Derive the {@link NetworkIdentity} for the currently configured Stellar
 * network. Cached after first call so it never re-parses the config.
 */
let _networkIdentity: NetworkIdentity | null = null;
export function getNetworkIdentity(): NetworkIdentity {
  if (!_networkIdentity) {
    const { networkPassphrase } = getStellarConfig();
    _networkIdentity = deriveNetworkIdentity(parseNetworkPassphrase(networkPassphrase));
  }
  return _networkIdentity;
}

/** Reset the cached identity — for tests only. */
export function _resetNetworkIdentityForTest(): void {
  _networkIdentity = null;
}

export interface TypedCacheKeyDescriptor {
  key: string;
  namespace: string;
  tags: string[];
}

export interface CacheSetOptions {
  tags?: string[];
  namespace?: string;
}

/**
 * Registry of tags used for granular and fan-out invalidation.
 */
export const tags = {
  arena: (arenaId: string) => `arena:${arenaId}`,
  round: (roundId: string) => `round:${roundId}`,
  user: (userId: string) => `user:${userId}`,
  pool: (poolId: string) => `pool:${poolId}`,
  arenas: () => "arenas:list",
  leaderboard: () => "leaderboard",
  oracle: () => "oracle",
};

/**
 * Versioned namespace helper functions.
 * Protects against Redis eviction of tag sets: even if tag sets are evicted,
 * an incremented tag version prevents stale data from being served.
 */
async function getCurrentTagVersions(tagList: string[]): Promise<Record<string, number>> {
  if (tagList.length === 0) return {};
  const versionKeys = tagList.map((t) => `tag:ver:${t}`);
  const versions = await redis.mget(...versionKeys);
  const result: Record<string, number> = {};
  tagList.forEach((t, i) => {
    result[t] = Number(versions[i] ?? 0);
  });
  return result;
}

async function recordKeyTagVersions(
  key: string,
  tagList: string[],
  ttlSeconds: number,
  pipeline: ReturnType<typeof redis.pipeline>,
): Promise<void> {
  const versions = await getCurrentTagVersions(tagList);
  pipeline.set(`${key}:tag_versions`, JSON.stringify(versions), "EX", ttlSeconds);
}

async function checkTagsStale(key: string, tagList: string[]): Promise<boolean> {
  try {
    const recordedRaw = await redis.get(`${key}:tag_versions`);
    if (!recordedRaw) return false;
    const recorded = JSON.parse(recordedRaw) as Record<string, number>;
    const current = await getCurrentTagVersions(tagList);

    for (const tag of tagList) {
      const recordedVer = recorded[tag] ?? 0;
      const currentVer = current[tag] ?? 0;
      if (currentVer > recordedVer) {
        // Tag was invalidated; drop stale key immediately
        await redis.del(key, `${key}:tag_versions`).catch(() => {});
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function invalidateTag(tag: string): Promise<void> {
  // 1. Increment version counter (versioned namespace)
  await redis.incr(`tag:ver:${tag}`);

  // 2. Multi-key fan-out deletion via Redis set
  const setKey = `tag:keys:${tag}`;
  const keys = await redis.smembers(setKey);
  if (keys.length > 0) {
    const versionKeys = keys.map((k) => `${k}:tag_versions`);
    await redis.del(...keys, ...versionKeys);
  }
  await redis.del(setKey);
}

export const cache = {
  async get<T>(keyOrDescriptor: string | TypedCacheKeyDescriptor): Promise<T | null> {
    const key = typeof keyOrDescriptor === "string" ? keyOrDescriptor : keyOrDescriptor.key;
    const namespace =
      typeof keyOrDescriptor === "string"
        ? (key.split(":")[0] ?? "unknown")
        : keyOrDescriptor.namespace;
    const tagList = typeof keyOrDescriptor === "string" ? [] : (keyOrDescriptor.tags ?? []);

    if (tagList.length > 0) {
      const isStale = await checkTagsStale(key, tagList);
      if (isStale) {
        cacheRequestsTotal.inc({ namespace, result: "miss" });
        return null;
      }
    }

    const data = await redis.get(key);
    if (!data) {
      cacheRequestsTotal.inc({ namespace, result: "miss" });
      return null;
    }

    cacheRequestsTotal.inc({ namespace, result: "hit" });
    return JSON.parse(data) as T;
  },

  async set(
    keyOrDescriptor: string | TypedCacheKeyDescriptor,
    value: unknown,
    ttlSeconds: number,
    options?: CacheSetOptions,
  ): Promise<void> {
    const key = typeof keyOrDescriptor === "string" ? keyOrDescriptor : keyOrDescriptor.key;
    const tagList =
      typeof keyOrDescriptor === "string" ? (options?.tags ?? []) : (keyOrDescriptor.tags ?? []);

    const pipeline = redis.pipeline();
    pipeline.set(key, JSON.stringify(value), "EX", ttlSeconds);

    if (tagList.length > 0) {
      for (const tag of tagList) {
        pipeline.sadd(`tag:keys:${tag}`, key);
        pipeline.expire(`tag:keys:${tag}`, Math.max(ttlSeconds, 3600));
      }
      await recordKeyTagVersions(key, tagList, ttlSeconds, pipeline);
    }

    await pipeline.exec();
  },

  async del(key: string): Promise<void> {
    await redis.del(key, `${key}:tag_versions`);
  },

  async invalidate(tag: string | string[]): Promise<void> {
    const tagArray = Array.isArray(tag) ? tag : [tag];
    for (const t of tagArray) {
      await invalidateTag(t);
    }
  },

  /** Atomically materialize a bounded page only when it is newer than the current generation. */
  async setIfGenerationIsNewer<T>(
    key: string,
    value: T,
    generation: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const generationKey = `${key}:generation`;
    const current = Number((await redis.get(generationKey)) ?? -1);
    if (generation < current) return false;
    await redis
      .multi()
      .set(key, JSON.stringify(value), "EX", ttlSeconds)
      .set(generationKey, String(generation), "EX", ttlSeconds)
      .exec();
    return true;
  },

  /**
   * Deletes keys matching `pattern` using non-blocking SCAN cursor iteration.
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
 * Typed Cache Key Registry.
 *
 * All cache reads and writes should go through typed key builders.
 * Every key descriptor includes the key string, its namespace for hit/miss metrics,
 * and associated invalidation tags.
 */
export const CacheKeys = {
  arena: {
    stats: (arenaId: string): TypedCacheKeyDescriptor => ({
      key: `arena:${getNetworkIdentity()}:stats:${arenaId}`,
      namespace: "arena_stats",
      tags: [tags.arena(arenaId)],
    }),
    health: (arenaId: string): TypedCacheKeyDescriptor => ({
      key: `arena:health:${arenaId}`,
      namespace: "arena_health",
      tags: [tags.arena(arenaId)],
    }),
    rounds: (
      arenaId: string,
      limit: number | string = 25,
      cursor: string = "0",
    ): TypedCacheKeyDescriptor => ({
      key: `arena:rounds:${arenaId}:${limit}:${cursor}`,
      namespace: "arena_rounds",
      tags: [tags.arena(arenaId)],
    }),
    yield: (
      arenaId: string,
      limit: number = 100,
      cursor: string = "",
    ): TypedCacheKeyDescriptor => ({
      key: `arena:${getNetworkIdentity()}:yield:${arenaId}:${limit}:${cursor}`,
      namespace: "arena_yield",
      tags: [tags.arena(arenaId)],
    }),
    onChainSnapshot: (arenaId: string): TypedCacheKeyDescriptor => ({
      key: `arena:${getNetworkIdentity()}:onchain-snapshot:${arenaId}`,
      namespace: "arena_onchain_snapshot",
      tags: [tags.arena(arenaId)],
    }),
    snapshotMeta: (arenaId: string): TypedCacheKeyDescriptor => ({
      key: `arena:${getNetworkIdentity()}:snapshot:meta:${arenaId}`,
      namespace: "arena_snapshot_meta",
      tags: [tags.arena(arenaId)],
    }),
    verifiedSnapshot: (arenaId: string): TypedCacheKeyDescriptor => ({
      key: `arena:${getNetworkIdentity()}:snapshot:verified:${arenaId}`,
      namespace: "arena_verified_snapshot",
      tags: [tags.arena(arenaId)],
    }),
    list: (
      filter: string = "all",
      search: string = "",
      limit: string | number = 25,
      cursor: string = "0",
    ): TypedCacheKeyDescriptor => ({
      key: `arenas:list:${filter}:${search}:${limit}:${cursor}`,
      namespace: "arenas_list",
      tags: [tags.arenas()],
    }),
  },
  pool: {
    eliminations: (
      poolId: string,
      limit: number | string = 25,
      cursor: string = "0",
    ): TypedCacheKeyDescriptor => ({
      key: `pool:eliminations:${poolId}:${limit}:${cursor}`,
      namespace: "pool_eliminations",
      tags: [tags.pool(poolId), tags.arena(poolId)],
    }),
  },
  round: {
    proofBundle: (roundId: string): TypedCacheKeyDescriptor => ({
      key: `round:proof-bundle:${roundId}`,
      namespace: "round_proof_bundle",
      tags: [tags.round(roundId)],
    }),
  },
  user: {
    profile: (userId: string): TypedCacheKeyDescriptor => ({
      key: `user:profile:${userId}`,
      namespace: "user_profile",
      tags: [tags.user(userId)],
    }),
  },
  oracle: {
    yield: (): TypedCacheKeyDescriptor => ({
      key: "oracle:yield",
      namespace: "oracle_yield",
      tags: [tags.oracle()],
    }),
  },
  leaderboard: (
    limit: number | string = 20,
    cursor: string = "0",
  ): TypedCacheKeyDescriptor => ({
    key: `leaderboard:${limit}:${cursor}`,
    namespace: "leaderboard",
    tags: [tags.leaderboard()],
  }),
  ledgerContinuity: (network: string): TypedCacheKeyDescriptor => ({
    key: `ledger:continuity:${network}`,
    namespace: "ledger_continuity",
    tags: [`ledger:${network}`],
  }),
};

/**
 * Backward-compatible cacheKeys interface.
 */
export const cacheKeys = {
  oracleYield: () => CacheKeys.oracle.yield().key,
  arenaStats: (arenaId: string) => CacheKeys.arena.stats(arenaId).key,
  leaderboard: () => CacheKeys.leaderboard().key,
  arenaOnChainSnapshot: (arenaId: string) => CacheKeys.arena.onChainSnapshot(arenaId).key,
  ledgerContinuity: (network: string) => CacheKeys.ledgerContinuity(network).key,
  roundProofBundle: (roundId: string) => CacheKeys.round.proofBundle(roundId).key,
  arenaSnapshotMeta: (arenaId: string) => CacheKeys.arena.snapshotMeta(arenaId).key,
  arenaVerifiedSnapshot: (arenaId: string) => CacheKeys.arena.verifiedSnapshot(arenaId).key,
  arenaYield: (arenaId: string, limit: number, cursor: string) =>
    CacheKeys.arena.yield(arenaId, limit, cursor).key,
};

export const arenaDerivedCachePatterns = ["arena:*:stats:*", "arena:*:onchain-snapshot:*"] as const;

export const cacheTTL = {
  ORACLE_YIELD: 60,
  ARENA_STATS: 15,
  ARENA_ROUNDS: 10,
  ARENA_YIELD: 60,
  ARENA_LIST: 30,
  LEADERBOARD: 30,
  ARENA_ONCHAIN_SNAPSHOT: 60 * 60 * 24,
  LEDGER_CONTINUITY: 60 * 60 * 24 * 7,
  ROUND_PROOF_BUNDLE: 300,
} as const;

/**
 * Explicit tag-based invalidation functions.
 */
export async function invalidateArena(arenaId: string): Promise<void> {
  await cache.invalidate(tags.arena(arenaId));
}

export async function invalidateRound(roundId: string): Promise<void> {
  await cache.invalidate(tags.round(roundId));
}

export async function invalidateUser(userId: string): Promise<void> {
  await cache.invalidate(tags.user(userId));
}

export async function invalidateArenaStats(arenaId: string): Promise<void> {
  await invalidateArena(arenaId);
}
