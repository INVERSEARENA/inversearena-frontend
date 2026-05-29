import type Redis from "ioredis";
import { redis as defaultRedis } from "./redisClient";

/**
 * Tracks active JWT IDs (JTIs) in Redis so individual sessions can be
 * revoked without waiting for the JWT to expire.
 *
 * Layout:
 *   auth:jti:{jti}      -> walletAddress  (TTL = remaining JWT lifetime)
 *   auth:wallet:{addr}  -> SET of jtis    (for wallet-wide revocation)
 *
 * The wallet-keyed set is the authoritative source for "all sessions for
 * this wallet"; the per-jti key carries the TTL so expired sessions clean
 * themselves up. We tolerate dangling members in the wallet set — they are
 * filtered out at read time by checking the per-jti key.
 */
export class SessionStore {
  constructor(private readonly client: Redis = defaultRedis) {}

  private jtiKey(jti: string): string {
    return `auth:jti:${jti}`;
  }

  private walletKey(walletAddress: string): string {
    return `auth:wallet:${walletAddress}`;
  }

  /**
   * Record a freshly-issued JTI as active. The per-jti key carries a TTL
   * that matches the JWT's remaining lifetime, so an expired token can
   * never pass `isActive` even if revocation was never called.
   */
  async addSession(
    walletAddress: string,
    jti: string,
    ttlSeconds: number,
  ): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await this.client.set(this.jtiKey(jti), walletAddress, "EX", ttl);
    await this.client.sadd(this.walletKey(walletAddress), jti);
  }

  /** True if the JTI is still in the active set and unexpired. */
  async isActive(jti: string): Promise<boolean> {
    const wallet = await this.client.get(this.jtiKey(jti));
    return wallet !== null;
  }

  /**
   * Invalidate a single session. Used by POST /auth/logout. Safe to call
   * with an unknown jti — Redis DEL/SREM both no-op on missing keys.
   */
  async removeSession(jti: string): Promise<void> {
    const wallet = await this.client.get(this.jtiKey(jti));
    await this.client.del(this.jtiKey(jti));
    if (wallet) {
      await this.client.srem(this.walletKey(wallet), jti);
    }
  }

  /**
   * Invalidate every active session for a wallet. Used by
   * DELETE /auth/sessions when a wallet is compromised or rotated.
   * Pipelines the per-jti deletes so the operation is one round-trip.
   */
  async removeAllSessions(walletAddress: string): Promise<number> {
    const jtis = await this.client.smembers(this.walletKey(walletAddress));
    if (jtis.length === 0) {
      await this.client.del(this.walletKey(walletAddress));
      return 0;
    }
    const pipeline = this.client.pipeline();
    for (const jti of jtis) {
      pipeline.del(this.jtiKey(jti));
    }
    pipeline.del(this.walletKey(walletAddress));
    await pipeline.exec();
    return jtis.length;
  }
}

export const sessionStore = new SessionStore();
