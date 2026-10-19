import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  type RateLimitPolicyConfig,
  type RouteClass,
  DEFAULT_POLICY_TABLE,
  getRoutePolicy,
  resolveClientIp,
  buildRateLimitKeys,
  getRateLimiter,
  consumeRateLimitKeys,
  clearLimiterCache as clearSharedLimiterCache,
  setSharedRedisClient,
} from "@inversearena/rate-limit";
import { redis } from "../cache/redisClient";
import { apiError } from "../utils/apiError";

// Configure shared limiter with backend's Redis instance
setSharedRedisClient(redis);

export type RateLimitConfig = RateLimitPolicyConfig;

export function getNonceRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("AUTH_NONCE");
}

export function getPoolsRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("POOLS_CREATE");
}

export function getSyncPlayersRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("ARENAS_SYNC_PLAYERS");
}

export function getLobbyReservationRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("ARENAS_RESERVATION");
}

export function getVerifyRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("AUTH_VERIFY");
}

export function getSimulationRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("SIMULATIONS");
}

export function getRefreshRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("AUTH_REFRESH");
}

export function getWalletRoleRateLimitConfig(): RateLimitConfig {
  return getRoutePolicy("ADMIN_WALLET_ROLE");
}

export function createRateLimitMiddleware(
  config: RateLimitConfig,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Resolve IP using the shared secure algorithm behind N proxies
    const ip = resolveClientIp(req.headers);
    const walletAddress =
      typeof req.body?.walletAddress === "string" ? req.body.walletAddress : null;

    const keys = buildRateLimitKeys({
      ip,
      walletAddress,
      dualScope: config.dualScope === true,
    });

    const limiter = getRateLimiter(config, redis);
    const result = await consumeRateLimitKeys(limiter, keys, config.durationSeconds);

    if (!result.allowed) {
      res.set("Retry-After", String(result.retryAfterSeconds));
      next(apiError(429, "RATE_LIMITED", "Too many requests. Please retry later."));
      return;
    }

    next();
  };
}

/** Expose limiter cache for test teardown (reset between suites). */
export function clearLimiterCache(): void {
  clearSharedLimiterCache();
}
