import type { NextRequest } from "next/server";
import {
  UNTRUSTED_CLIENT_BUCKET,
  getTrustedProxyCount,
  resolveClientIp as sharedResolveClientIp,
  consumeNextRateLimit,
  buildNextRateLimitRejection,
  getRateLimiter,
  consumeRateLimitKeys,
  type RateLimitConsumeResult,
  type RateLimitPolicyConfig,
} from "@inversearena/rate-limit";
import type { RouteRateLimitConfig } from "./config";

export { UNTRUSTED_CLIENT_BUCKET, getTrustedProxyCount };

export function resolveClientIp(request: { headers: { get(name: string): string | null } }): string {
  return sharedResolveClientIp(request.headers);
}

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

// Surface misconfiguration at startup
const isUnderTestRunner =
  process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
if (!isUnderTestRunner) {
  warnOnInsecureRateLimitConfig();
}

export async function consumeRateLimit(args: {
  config: RouteRateLimitConfig;
  request: { headers: { get(name: string): string | null } };
  walletAddress?: string | null;
}): Promise<RateLimitConsumeResult> {
  return consumeNextRateLimit({
    policyOrConfig: args.config,
    request: args.request,
    walletAddress: args.walletAddress,
  });
}

export async function consumeRateLimitByKey(args: {
  config: RouteRateLimitConfig;
  key: string;
}): Promise<RateLimitConsumeResult> {
  const limiter = getRateLimiter(args.config);
  return consumeRateLimitKeys(limiter, [args.key], args.config.durationSeconds);
}

export async function buildRateLimitRejection(args: {
  config: RouteRateLimitConfig;
  request: { headers: { get(name: string): string | null } };
  walletAddress?: string | null;
}): Promise<Response | null> {
  return buildNextRateLimitRejection({
    policyOrConfig: args.config,
    request: args.request,
    walletAddress: args.walletAddress,
  });
}
