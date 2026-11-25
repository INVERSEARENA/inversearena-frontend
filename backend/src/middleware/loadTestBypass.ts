/**
 * loadTestBypass middleware
 *
 * When the backend is started with a LOAD_TEST_BYPASS_KEY environment variable
 * set, any request that presents a matching X-Load-Test-Key header is tagged on
 * req so that rate-limit middleware can skip counting for that request.
 *
 * Issue #1784:
 *  - Constant-time comparison prevents timing-side-channel key leaks.
 *  - Boot-time guard refuses to start (throws) when NODE_ENV=production and
 *    LOAD_TEST_BYPASS_KEY is set, so the bypass can never accidentally reach
 *    production.
 */

import { timingSafeEqual } from "node:crypto";
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
 * Throws at startup when a test-only bypass switch is active in production.
 * Call once from app bootstrap before mounting any middleware.
 */
export function assertNoTestBypassInProduction(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.LOAD_TEST_BYPASS_KEY) {
    throw new Error(
      "[FATAL] LOAD_TEST_BYPASS_KEY must not be set in production. " +
        "Remove this variable and restart.",
    );
  }
}

/** Constant-time comparison to prevent timing-based key leakage. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Lengths differ — still run a dummy comparison so elapsed time is similar.
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Returns a middleware that sets req.__loadTestBypass = true when:
 *   1. process.env.LOAD_TEST_BYPASS_KEY is set and long enough, AND
 *   2. the incoming X-Load-Test-Key header matches it (constant-time compare).
 *
 * When LOAD_TEST_BYPASS_KEY is absent or too short the returned middleware is a
 * no-op (does not read the header at all).
 */
export function createLoadTestBypassMiddleware(): RequestHandler {
  // Refuse to arm the bypass in production (#1784).
  assertNoTestBypassInProduction();

  const bypassKey = process.env.LOAD_TEST_BYPASS_KEY ?? "";

  if (!bypassKey || bypassKey.length < MIN_KEY_LENGTH) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers["x-load-test-key"];
    if (typeof header === "string" && safeEqual(header, bypassKey)) {
      req.__loadTestBypass = true;
    }
    next();
  };
}
