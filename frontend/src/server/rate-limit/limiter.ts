import type { NextRequest } from "next/server";
import IORedis from "ioredis";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type IRateLimiterStoreOptions,
  type RateLimiterAbstract,
} from "rate-limiter-flexible";

import type { RouteRateLimitConfig } from "./config";

type RateLimitConsumeResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

let redisClient: IORedis | null = null;
const limiterCache = new Map<string, RateLimiterAbstract>();

function resolveClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  return "unknown";
}

function getRedisClient(): IORedis | null {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  if (redisClient) {
    return redisClient;
  }

  redisClient = new IORedis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });

  return redisClient;
}

function createLimiter(config: RouteRateLimitConfig): RateLimiterAbstract {
  const redis = getRedisClient();
  const baseOptions = {
    keyPrefix: config.keyPrefix,
    points: config.points,
    duration: config.durationSeconds,
  };

  if (!redis) {
    return new RateLimiterMemory(baseOptions);
  }

  return new RateLimiterRedis({
    ...baseOptions,
    storeClient: redis,
    insuranceLimiter: new RateLimiterMemory(baseOptions),
  });
}

function getLimiter(config: RouteRateLimitConfig): RateLimiterAbstract {
  const cacheKey = `${config.keyPrefix}:${config.points}:${config.durationSeconds}`;
  const existing = limiterCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const limiter = createLimiter(config);
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

export async function consumeRateLimit(args: {
  config: RouteRateLimitConfig;
  request: NextRequest;
  walletAddress?: string | null;
}): Promise<RateLimitConsumeResult> {
  const ip = resolveClientIp(args.request);
  const key = args.walletAddress
    ? `ip:${ip}:wallet:${args.walletAddress.toLowerCase()}`
    : `ip:${ip}`;

  return consumeRateLimitByKey({ config: args.config, key });
}

export async function consumeRateLimitByKey(args: {
  config: RouteRateLimitConfig;
  key: string;
}): Promise<RateLimitConsumeResult> {
  const limiter = getLimiter(args.config);
  try {
    await limiter.consume(args.key, 1);
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  } catch (error) {
    const typed = error as { msBeforeNext?: number };
    const msBeforeNext = typed.msBeforeNext ?? args.config.durationSeconds * 1_000;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(msBeforeNext / 1_000)),
    };
  }
}

export async function buildRateLimitRejection(args: {
  config: RouteRateLimitConfig;
  request: NextRequest;
  walletAddress?: string | null;
}): Promise<Response | null> {
  const decision = await consumeRateLimit(args);
  if (decision.allowed) {
    return null;
  }

  return new Response(
    JSON.stringify({
      error: "Too many requests. Please retry later.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(decision.retryAfterSeconds),
      },
    }
  );
}
