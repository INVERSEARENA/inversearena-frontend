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

/** Sentinel bucket used when the real client IP cannot be trusted/determined. */
export const UNTRUSTED_CLIENT_BUCKET = "unknown";

/**
 * Number of trusted reverse proxies (CDN, load balancer, ingress) sitting
 * between an external client and this app, read from `TRUSTED_PROXY_COUNT`.
 *
 * `0` (the default) means "we are not behind a known proxy", so
 * `X-Forwarded-For` / `X-Real-IP` are attacker-controlled and must not be
 * trusted for rate-limit bucketing.
 */
export function getTrustedProxyCount(): number {
  const raw = process.env.TRUSTED_PROXY_COUNT;
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

/**
 * Resolve the client IP to bucket a rate-limit key on.
 *
 * `X-Forwarded-For` is only honoured when `TRUSTED_PROXY_COUNT` confirms how
 * many trusted proxies are in front of us: the right-most `count` entries are
 * the ones our own infrastructure appended, so the real remote peer is the
 * entry immediately to their left (`parts.length - count`). Anything a direct
 * caller prepends lands further left and is ignored — so a client can no
 * longer spoof the header to mint a fresh rate-limit bucket per request
 * (#1297).
 *
 * When we are not behind a known proxy, every caller shares the
 * {@link UNTRUSTED_CLIENT_BUCKET} bucket (fail closed) rather than trusting a
 * spoofable header.
 */
export function resolveClientIp(request: NextRequest): string {
  const trustedProxyCount = getTrustedProxyCount();
  if (trustedProxyCount === 0) {
    return UNTRUSTED_CLIENT_BUCKET;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    // Header must be at least as long as the trusted-proxy chain we expect;
    // a shorter one means it was stripped or the request didn't come through
    // the proxy at all.
    if (parts.length >= trustedProxyCount) {
      const clientIp = parts[parts.length - trustedProxyCount];
      if (clientIp) {
        return clientIp;
      }
    }
  }

  // Proxies that set X-Real-IP overwrite (not append) it, so it is safe to
  // trust once we've established we sit behind at least one trusted proxy.
  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) {
    return realIp.trim();
  }

  return UNTRUSTED_CLIENT_BUCKET;
}

let hasWarnedInsecureConfig = false;

/**
 * Emit a one-time startup warning for rate-limit configurations that silently
 * weaken the limiter:
 *  - no `REDIS_URL` → per-process in-memory limiting, so the real global limit
 *    becomes `points × instance_count` on any multi-instance deployment.
 *  - `TRUSTED_PROXY_COUNT` unset → `X-Forwarded-For` is ignored and every
 *    caller shares a single bucket.
 */
export function warnOnInsecureRateLimitConfig(
  logger: Pick<Console, "warn"> = console,
): void {
  if (!process.env.REDIS_URL) {
    logger.warn(
      "[rate-limit] REDIS_URL is not set — using in-memory rate limiting. " +
        "On multi-instance/serverless deployments the effective limit becomes " +
        "points × instance_count. Set REDIS_URL for a shared global limit.",
    );
  }
  if (getTrustedProxyCount() === 0) {
    logger.warn(
      "[rate-limit] TRUSTED_PROXY_COUNT is unset/0 — X-Forwarded-For and " +
        "X-Real-IP are ignored and all callers share one rate-limit bucket. " +
        "Set it to the number of trusted proxies in front of this app to " +
        "enable per-client limiting.",
    );
  }
}

// Surface misconfiguration at startup (module load) rather than silently
// degrading. Skipped under test runners, which assert on the function directly.
const isUnderTestRunner =
  process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
if (!isUnderTestRunner && !hasWarnedInsecureConfig) {
  hasWarnedInsecureConfig = true;
  warnOnInsecureRateLimitConfig();
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
