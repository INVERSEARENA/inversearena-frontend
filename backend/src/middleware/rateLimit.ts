import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
} from "rate-limiter-flexible";
import { redis } from "../cache/redisClient";
import { apiError } from "../utils/apiError";

export interface RateLimitConfig {
  keyPrefix: string;
  points: number;
  durationSeconds: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export const nonceRateLimitConfig: RateLimitConfig = {
  keyPrefix: process.env.RATE_LIMIT_NONCE_PREFIX ?? "rl:auth:nonce",
  points: readPositiveInt("RATE_LIMIT_NONCE_POINTS", 5),
  durationSeconds: readPositiveInt("RATE_LIMIT_NONCE_WINDOW_SECONDS", 60),
};

export const poolsRateLimitConfig: RateLimitConfig = {
  keyPrefix: process.env.RATE_LIMIT_POOLS_PREFIX ?? "rl:pools:create",
  points: readPositiveInt("RATE_LIMIT_POOLS_POINTS", 3),
  durationSeconds: readPositiveInt("RATE_LIMIT_POOLS_WINDOW_SECONDS", 60),
};

const limiterCache = new Map<string, RateLimiterAbstract>();

function getLimiter(config: RateLimitConfig): RateLimiterAbstract {
  const cacheKey = `${config.keyPrefix}:${config.points}:${config.durationSeconds}`;
  const existing = limiterCache.get(cacheKey);
  if (existing) return existing;

  const baseOptions = {
    keyPrefix: config.keyPrefix,
    points: config.points,
    duration: config.durationSeconds,
  };

  const redisUrl = process.env.REDIS_URL;
  const limiter = redisUrl
    ? new RateLimiterRedis({
        ...baseOptions,
        storeClient: redis,
        insuranceLimiter: new RateLimiterMemory(baseOptions),
      })
    : new RateLimiterMemory(baseOptions);

  limiterCache.set(cacheKey, limiter);
  return limiter;
}

function resolveIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}

export function createRateLimitMiddleware(
  config: RateLimitConfig,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = resolveIp(req);
    const walletAddress =
      typeof req.body?.walletAddress === "string"
        ? req.body.walletAddress.toLowerCase()
        : null;

    const key = walletAddress
      ? `ip:${ip}:wallet:${walletAddress}`
      : `ip:${ip}`;

    const limiter = getLimiter(config);

    try {
      await limiter.consume(key, 1);
      next();
    } catch (err) {
      const typed = err as { msBeforeNext?: number };
      const retryAfter = Math.max(
        1,
        Math.ceil((typed.msBeforeNext ?? config.durationSeconds * 1_000) / 1_000),
      );
      res.set("Retry-After", String(retryAfter));
      next(apiError(429, "RATE_LIMITED", "Too many requests. Please retry later."));
    }
  };
}

/** Expose limiter cache for test teardown (reset between suites). */
export function clearLimiterCache(): void {
  limiterCache.clear();
}
