/**
 * loadTestBypass middleware
 *
 * When the backend is started with a LOAD_TEST_BYPASS_KEY environment variable
 * set, any request that presents a matching X-Load-Test-Key header is tagged on
 * req so that rate-limit middleware can skip counting for that request.
 *
 * This avoids k6 VUs — which all share the loopback address — from exhausting
 * rate-limit buckets and producing misleading results.
 *
 * Security model:
 *   • The bypass is only active when LOAD_TEST_BYPASS_KEY is set.
 *   • The key must be a non-trivial secret (min 16 chars) to prevent accidental
 *     activation with a short/guessable value.
 *   • In production deployments where load tests are never run, simply leave
 *     LOAD_TEST_BYPASS_KEY unset — the middleware becomes a no-op.
 *   • Never set this variable in production.
 *
 * Usage in k6 scenarios:
 *   k6 run -e BYPASS_RATE_LIMIT=1 \
 *          -e LOAD_TEST_SECRET_KEY=<same-value-as-LOAD_TEST_BYPASS_KEY> …
 *
 * Extend createRateLimitMiddleware() to honour the flag:
 *   if ((req as any).__loadTestBypass) return next();
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set to true by loadTestBypassMiddleware when the bypass key matches. */
      __loadTestBypass?: boolean;
    }
  }
}

const MIN_KEY_LENGTH = 16;

/**
 * Returns a middleware that sets req.__loadTestBypass = true when:
 *   1. process.env.LOAD_TEST_BYPASS_KEY is set and long enough, AND
 *   2. the incoming X-Load-Test-Key header matches it exactly.
 *
 * When LOAD_TEST_BYPASS_KEY is absent or too short the returned middleware is a
 * no-op (does not read the header at all).
 */
export function createLoadTestBypassMiddleware(): RequestHandler {
  const bypassKey = process.env.LOAD_TEST_BYPASS_KEY ?? "";

  if (!bypassKey || bypassKey.length < MIN_KEY_LENGTH) {
    // No-op: bypass is disabled.
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers["x-load-test-key"];
    if (typeof header === "string" && header === bypassKey) {
      req.__loadTestBypass = true;
    }
    next();
  };
}
