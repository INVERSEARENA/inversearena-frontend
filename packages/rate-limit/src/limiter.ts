import IORedis from "ioredis";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
} from "rate-limiter-flexible";
import type { RateLimitConsumeResult, RateLimitPolicyConfig } from "./types";

let redisClient: IORedis | null = null;
const limiterCache = new Map<string, RateLimiterAbstract>();

export function setSharedRedisClient(client: IORedis | null): void {
  redisClient = client;
}

export function getSharedRedisClient(): IORedis | null {
  if (redisClient) return redisClient;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  redisClient = new IORedis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  return redisClient;
}

export function clearLimiterCache(): void {
  limiterCache.clear();
}

export function getRateLimiter(
  config: RateLimitPolicyConfig,
  customRedis?: IORedis | null,
): RateLimiterAbstract {
  const cacheKey = `${config.keyPrefix}:${config.points}:${config.durationSeconds}`;
  const existing = limiterCache.get(cacheKey);
  if (existing) return existing;

  const baseOptions = {
    keyPrefix: config.keyPrefix,
    points: config.points,
    duration: config.durationSeconds,
  };

  const hasRedisUrl = Boolean(process.env.REDIS_URL);
  const redis = hasRedisUrl
    ? (customRedis !== undefined ? customRedis : getSharedRedisClient())
    : null;
  const limiter = redis
    ? new RateLimiterRedis({
        ...baseOptions,
        storeClient: redis,
        insuranceLimiter: new RateLimiterMemory(baseOptions),
      })
    : new RateLimiterMemory(baseOptions);

  limiterCache.set(cacheKey, limiter);
  return limiter;
}

export async function consumeRateLimitKeys(
  limiter: RateLimiterAbstract,
  keys: string[],
  durationSeconds: number,
): Promise<RateLimitConsumeResult> {
  let worstMsBeforeNext = 0;
  let blocked = false;

  for (const key of keys) {
    try {
      await limiter.consume(key, 1);
    } catch (err) {
      blocked = true;
      const typed = err as { msBeforeNext?: number };
      const ms = typed.msBeforeNext ?? durationSeconds * 1_000;
      if (ms > worstMsBeforeNext) {
        worstMsBeforeNext = ms;
      }
    }
  }

  if (blocked) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(worstMsBeforeNext / 1_000)),
    };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
  };
}
