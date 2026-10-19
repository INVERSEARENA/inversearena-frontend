import type { Request, Response, NextFunction, RequestHandler } from "express";
import { resolveClientIp } from "../ip";
import { buildRateLimitKeys } from "../keys";
import { getRateLimiter, consumeRateLimitKeys } from "../limiter";
import { getRoutePolicy } from "../policy";
import type { RateLimitPolicyConfig, RouteClass } from "../types";

export interface ExpressRateLimitOptions {
  appNamespace?: string;
  onRejected?: (req: Request, res: Response, next: NextFunction, retryAfterSeconds: number) => void;
}

export function createExpressRateLimitMiddleware(
  policyOrConfig: RouteClass | RateLimitPolicyConfig,
  options: ExpressRateLimitOptions = {},
): RequestHandler {
  const config =
    typeof policyOrConfig === "string"
      ? getRoutePolicy(policyOrConfig)
      : policyOrConfig;

  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = resolveClientIp(req.headers);
    const walletAddress =
      typeof req.body?.walletAddress === "string" ? req.body.walletAddress : null;

    const keys = buildRateLimitKeys({
      ip,
      walletAddress,
      dualScope: config.dualScope === true,
      appNamespace: options.appNamespace,
    });

    const limiter = getRateLimiter(config);
    const decision = await consumeRateLimitKeys(limiter, keys, config.durationSeconds);

    if (!decision.allowed) {
      res.set("Retry-After", String(decision.retryAfterSeconds));
      if (options.onRejected) {
        options.onRejected(req, res, next, decision.retryAfterSeconds);
        return;
      }

      // Default rejection if no custom handler provided
      const error: any = new Error("Too many requests. Please retry later.");
      error.status = 429;
      error.statusCode = 429;
      error.code = "RATE_LIMITED";
      next(error);
      return;
    }

    next();
  };
}
