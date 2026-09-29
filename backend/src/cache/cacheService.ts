import { redis } from "./redisClient";
import {
  type NetworkIdentity,
  deriveNetworkIdentity,
  parseNetworkPassphrase,
} from "../../frontend/src/shared-d/utils/identity-value-objects";
import { getStellarConfig } from "../config/stellarConfig";

/**
 * Derive the {@link NetworkIdentity} for the currently configured Stellar
 * network.  Cached after first call so it never re-parses the config.
 *
 * All arena-derived cache keys include this identity so that a testnet arena
 * ID that happens to share characters with a mainnet ID never hits the same
 * cache slot (#1522).
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

  /** Atomically materialize a bounded page only when it is newer than the current generation. */
  async setIfGenerationIsNewer<T>(key: string, value: T, generation: number, ttlSeconds: number): Promise<boolean> {
    const generationKey = `${key}:generation`;
    const current = Number(await redis.get(generationKey) ?? -1);
    if (generation < current) return false;
    await redis.multi().set(key, JSON.stringify(value), "EX", ttlSeconds).set(generationKey, String(generation), "EX", ttlSeconds).exec();
    return true;
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
 * Cache key builders.
 *
 * Arena-derived keys now include the canonical network identity (#1522) so
 * testnet and mainnet arenas can never collide in a shared Redis instance.
 * The network segment is derived from the `STELLAR_NETWORK_PASSPHRASE` env
 * var via {@link getNetworkIdentity}.
 *
 * Non-arena keys (leaderboard, oracle yield, sessions, ledger continuity) are
 * not arena-scoped and keep their existing format.
 */
export const cacheKeys = {
  oracleYield: () => "oracle:yield",
  /** Arena stats — includes network identity to prevent cross-network collisions (#1522). */
  arenaStats: (arenaId: string) => `arena:${getNetworkIdentity()}:stats:${arenaId}`,
  leaderboard: () => "leaderboard",
  /**
   * The last *live* (non-degraded) on-chain read for an arena (#1408) —
   * deliberately a separate, long-lived key from arenaStats: arenaStats is a
   * disposable 15s cache of the full computed response, while this is the
   * "last known good" record a degraded response falls back to when a fresh
   * on-chain read fails.
   *
   * Includes network identity (#1522).
   */
  arenaOnChainSnapshot: (arenaId: string) => `arena:${getNetworkIdentity()}:onchain-snapshot:${arenaId}`,
  /** Persisted ledger continuity window and recovery state (#1490). */
  ledgerContinuity: (network: string) => `ledger:continuity:${network}`,
  /** #1394: a resolved round's proof bundle is immutable for a given roundId. */
  roundProofBundle: (roundId: string) => `round:proof-bundle:${roundId}`,
  /** #1500: canonical snapshot metadata for semantic change detection. Includes network identity (#1522). */
  arenaSnapshotMeta: (arenaId: string) => `arena:${getNetworkIdentity()}:snapshot:meta:${arenaId}`,
  /** #1500: verified full snapshot payload with version generation. Includes network identity (#1522). */
  arenaVerifiedSnapshot: (arenaId: string) => `arena:${getNetworkIdentity()}:snapshot:verified:${arenaId}`,
};

/**
 * Key patterns for everything derived from ledger reads per arena (#1490).
 * A ledger rollback invalidates exactly these; unrelated keys (leaderboard,
 * oracle yield, sessions) are not derived from arena ledger state.
 *
 * Patterns use a wildcard for the network segment so rollbacks invalidate
 * across all networks in a shared Redis instance (#1522).
 */
export const arenaDerivedCachePatterns = ["arena:*:stats:*", "arena:*:onchain-snapshot:*"] as const;

/**
 * TTLs in seconds
 *
 * oracle:yield        → 60s   (yield rates change slowly)
 * arena:stats         → 15s   (arena state changes with game rounds)
 * leaderboard         → 30s   (updates after games end)
 * round:proof-bundle  → 300s  (immutable once resolved — see cacheKeys.roundProofBundle;
 *                               bounded rather than infinite so a corrected redeploy can
 *                               still self-heal a bad cached entry within 5 minutes)
 */
export const cacheTTL = {
  ORACLE_YIELD: 60,
  ARENA_STATS: 15,
  ARENA_ROUNDS: 10,
  LEADERBOARD: 30,
  // Deliberately long: this is "how far back may a degraded response reach",
  // not "how fresh is a normal response". Every degraded response carries its
  // own ledgerSequence/verifiedAt regardless of how old it is, so a generous
  // TTL trades a longer possible staleness window for surviving a longer
  // Soroban outage without falling all the way back to unflagged DB data.
  ARENA_ONCHAIN_SNAPSHOT: 60 * 60 * 24,
  // Continuity state must outlive a restart during recovery, but not linger
  // forever if the deployment is retired.
  LEDGER_CONTINUITY: 60 * 60 * 24 * 7,
  ROUND_PROOF_BUNDLE: 300,
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
