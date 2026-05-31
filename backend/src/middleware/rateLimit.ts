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
  /** When true, enforce separate IP and wallet buckets (wallet from req.body.walletAddress). */
  dualScope?: boolean;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function getNonceRateLimitConfig(): RateLimitConfig {
  return {
    keyPrefix: process.env.RATE_LIMIT_NONCE_PREFIX ?? "rl:auth:nonce",
    points: readPositiveInt("RATE_LIMIT_NONCE_POINTS", 5),
    durationSeconds: readPositiveInt("RATE_LIMIT_NONCE_WINDOW_SECONDS", 60),
  };
}

export function getPoolsRateLimitConfig(): RateLimitConfig {
  return {
    keyPrefix: process.env.RATE_LIMIT_POOLS_PREFIX ?? "rl:pools:create",
    points: readPositiveInt("RATE_LIMIT_POOLS_POINTS", 3),
    durationSeconds: readPositiveInt("RATE_LIMIT_POOLS_WINDOW_SECONDS", 60),
  };
}

export function getVerifyRateLimitConfig(): RateLimitConfig {
  return {
    keyPrefix: process.env.RATE_LIMIT_VERIFY_PREFIX ?? "rl:auth:verify",
    points: readPositiveInt("RATE_LIMIT_VERIFY_POINTS", 10),
    durationSeconds: readPositiveInt("RATE_LIMIT_VERIFY_WINDOW_SECONDS", 60),
    dualScope: true,
  };
}

export function getRefreshRateLimitConfig(): RateLimitConfig {
  return {
    keyPrefix: process.env.RATE_LIMIT_REFRESH_PREFIX ?? "rl:auth:refresh",
    points: readPositiveInt("RATE_LIMIT_REFRESH_POINTS", 20),
    durationSeconds: readPositiveInt("RATE_LIMIT_REFRESH_WINDOW_SECONDS", 60),
  };
}

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

function buildRateLimitKeys(
  ip: string,
  walletAddress: string | null,
  dualScope: boolean,
): string[] {
  if (dualScope && walletAddress) {
    return [`ip:${ip}`, `wallet:${walletAddress}`];
  }
  if (walletAddress) {
    return [`ip:${ip}:wallet:${walletAddress}`];
  }
  return [`ip:${ip}`];
}

async function consumeKeys(
  limiter: RateLimiterAbstract,
  keys: string[],
): Promise<{ msBeforeNext?: number } | null> {
  for (const key of keys) {
    try {
      await limiter.consume(key, 1);
    } catch (err) {
      const typed = err as { msBeforeNext?: number };
      if (typed.msBeforeNext !== undefined) {
        return { msBeforeNext: typed.msBeforeNext };
      }
      return {};
    }
  }
  return null;
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

    const keys = buildRateLimitKeys(ip, walletAddress, config.dualScope === true);
    const limiter = getLimiter(config);

    const rejection = await consumeKeys(limiter, keys);
    if (rejection) {
      const retryAfter = Math.max(
        1,
        Math.ceil(
          (rejection.msBeforeNext ?? config.durationSeconds * 1_000) / 1_000,
        ),
      );
      res.set("Retry-After", String(retryAfter));
      next(apiError(429, "RATE_LIMITED", "Too many requests. Please retry later."));
      return;
    }

    next();
  };
}

/** Expose limiter cache for test teardown (reset between suites). */
export function clearLimiterCache(): void {
  limiterCache.clear();
}
