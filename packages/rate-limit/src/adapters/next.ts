import { resolveClientIp } from "../ip";
import { buildRateLimitKeys } from "../keys";
import { getRateLimiter, consumeRateLimitKeys } from "../limiter";
import { getRoutePolicy } from "../policy";
import type { RateLimitConsumeResult, RateLimitPolicyConfig, RouteClass } from "../types";

export interface NextRateLimitArgs {
  policyOrConfig: RouteClass | RateLimitPolicyConfig;
  request: { headers: { get(name: string): string | null } };
  walletAddress?: string | null;
  appNamespace?: string;
}

export async function consumeNextRateLimit(
  args: NextRateLimitArgs,
): Promise<RateLimitConsumeResult> {
  const config =
    typeof args.policyOrConfig === "string"
      ? getRoutePolicy(args.policyOrConfig)
      : args.policyOrConfig;

  const ip = resolveClientIp(args.request.headers);
  const keys = buildRateLimitKeys({
    ip,
    walletAddress: args.walletAddress,
    dualScope: config.dualScope === true,
    appNamespace: args.appNamespace,
  });

  const limiter = getRateLimiter(config);
  return consumeRateLimitKeys(limiter, keys, config.durationSeconds);
}

export async function buildNextRateLimitRejection(
  args: NextRateLimitArgs,
): Promise<Response | null> {
  const decision = await consumeNextRateLimit(args);
  if (decision.allowed) {
    return null;
  }

  const body = JSON.stringify({
    error: "Too many requests. Please retry later.",
  });

  if (typeof globalThis.Response !== "undefined") {
    return new globalThis.Response(body, {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(decision.retryAfterSeconds),
      },
    });
  }

  const headersMap = new Map<string, string>([
    ["content-type", "application/json"],
    ["retry-after", String(decision.retryAfterSeconds)],
  ]);

  return {
    status: 429,
    headers: {
      get: (name: string) => headersMap.get(name.toLowerCase()) ?? null,
    },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}
