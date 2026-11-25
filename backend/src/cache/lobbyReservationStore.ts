import type Redis from "ioredis";
import { redis as defaultRedis } from "./redisClient";

/**
 * Backend-authoritative lobby capacity reservations (#1406).
 *
 * A player deciding to join an arena needs a slot held for them for the
 * seconds/minutes it takes to review terms and sign the stake transaction —
 * without one, two players racing for the arena's last slot could both start
 * signing, and only discover the arena was full after paying a network fee.
 *
 * Layout: one Redis sorted set per arena, `lobby:reservations:{arenaId}`,
 * member = userId, score = the reservation's expiry (unix ms). A sorted set
 * gives us both "how many active reservations" (after pruning expired
 * members) and per-member TTL semantics without a second key per user.
 *
 * The reserve operation is a single Lua script (one atomic Redis command),
 * so two callers racing for the same final slot cannot both observe
 * "room available" before either writes — one succeeds, one is rejected in
 * the same round-trip. Expiry is deterministic: a reservation older than
 * `ttlSeconds` is pruned (ZREMRANGEBYSCORE) before every capacity check,
 * including the racing caller's own attempt, so a reservation can never
 * outlive its TTL regardless of Redis key-expiry timing.
 */

// KEYS[1] = reservation set key
// ARGV[1] = userId
// ARGV[2] = now (ms)
// ARGV[3] = expiresAt (ms) = now + ttlSeconds*1000
// ARGV[4] = capacity remaining for *new* reservations, i.e.
//           maxPlayers - confirmedPlayerCount (computed by the caller from
//           the DB/on-chain player count, since that isn't Redis's job)
//
// Returns 1 if the slot was reserved (or the caller already held one, which
// refreshes its TTL rather than double-counting), 0 if the arena is full.
const RESERVE_SLOT_SCRIPT = `
local key = KEYS[1]
local userId = ARGV[1]
local now = tonumber(ARGV[2])
local expiresAt = tonumber(ARGV[3])
local remainingCapacity = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

local alreadyHeld = redis.call('ZSCORE', key, userId)
if alreadyHeld then
  redis.call('ZADD', key, expiresAt, userId)
  return 1
end

local activeCount = redis.call('ZCARD', key)
if activeCount >= remainingCapacity then
  return 0
end

redis.call('ZADD', key, expiresAt, userId)
return 1
`;

export interface ReserveSlotResult {
  reserved: boolean;
  expiresAt: string | null;
}

export class LobbyReservationStore {
  constructor(private readonly client: Redis = defaultRedis) {}

  private reservationKey(arenaId: string): string {
    return `lobby:reservations:${arenaId}`;
  }

  /**
   * Attempts to reserve one lobby slot for `userId` in `arenaId`.
   *
   * `remainingCapacity` must be `maxPlayers - confirmedPlayerCount` as of
   * the moment of this call (the caller — the route handler — owns reading
   * that from the DB/on-chain source; this store only arbitrates the
   * in-flight reservations layered on top of it).
   */
  async reserveSlot(
    arenaId: string,
    userId: string,
    remainingCapacity: number,
    ttlSeconds: number,
  ): Promise<ReserveSlotResult> {
    if (remainingCapacity <= 0) {
      // Never even attempt the script when confirmed players alone already
      // fill (or exceed) capacity — nothing left for reservations to arbitrate.
      return { reserved: false, expiresAt: null };
    }

    const now = Date.now();
    const expiresAt = now + Math.max(1, Math.floor(ttlSeconds)) * 1000;

    const result = await this.client.eval(
      RESERVE_SLOT_SCRIPT,
      1,
      this.reservationKey(arenaId),
      userId,
      String(now),
      String(expiresAt),
      String(remainingCapacity),
    );

    const reserved = result === 1;
    return {
      reserved,
      expiresAt: reserved ? new Date(expiresAt).toISOString() : null,
    };
  }

  /** Releases userId's reservation early, e.g. on explicit cancel or a confirmed join. */
  async releaseSlot(arenaId: string, userId: string): Promise<void> {
    await this.client.zrem(this.reservationKey(arenaId), userId);
  }

  /** Count of currently-active (non-expired) reservations for an arena. */
  async activeReservationCount(arenaId: string): Promise<number> {
    const key = this.reservationKey(arenaId);
    const now = Date.now();
    await this.client.zremrangebyscore(key, "-inf", now);
    return this.client.zcard(key);
  }

  /** True if userId currently holds an unexpired reservation for arenaId. */
  async hasReservation(arenaId: string, userId: string): Promise<boolean> {
    const score = await this.client.zscore(this.reservationKey(arenaId), userId);
    if (score === null) return false;
    return Number(score) > Date.now();
  }
}

export const lobbyReservationStore = new LobbyReservationStore();
