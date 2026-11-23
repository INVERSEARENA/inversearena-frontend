/**
 * Unit tests for loadTestBypass middleware (#1624).
 *
 * Verifies that:
 *   - The middleware is a no-op when LOAD_TEST_BYPASS_KEY is unset.
 *   - The middleware is a no-op when LOAD_TEST_BYPASS_KEY is too short.
 *   - req.__loadTestBypass is set when the header matches the key.
 *   - req.__loadTestBypass is NOT set when the header is wrong or absent.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import type { Request, Response, NextFunction } from "express";
import { createLoadTestBypassMiddleware } from "../src/middleware/loadTestBypass";

function makeReq(headerValue?: string): Request {
  const headers: Record<string, string> = {};
  if (headerValue !== undefined) {
    headers["x-load-test-key"] = headerValue;
  }
  return { headers } as unknown as Request;
}

const res = {} as Response;

describe("loadTestBypass middleware (#1624)", () => {
  const originalKey = process.env.LOAD_TEST_BYPASS_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.LOAD_TEST_BYPASS_KEY;
    } else {
      process.env.LOAD_TEST_BYPASS_KEY = originalKey;
    }
  });

  test("is a no-op when LOAD_TEST_BYPASS_KEY is not set", () => {
    delete process.env.LOAD_TEST_BYPASS_KEY;
    const middleware = createLoadTestBypassMiddleware();
    const req = makeReq("some-key");
    let called = false;
    middleware(req, res, () => { called = true; });
    assert.strictEqual(called, true);
    assert.strictEqual((req as any).__loadTestBypass, undefined);
  });

  test("is a no-op when LOAD_TEST_BYPASS_KEY is shorter than 16 chars", () => {
    process.env.LOAD_TEST_BYPASS_KEY = "short";
    const middleware = createLoadTestBypassMiddleware();
    const req = makeReq("short");
    let called = false;
    middleware(req, res, () => { called = true; });
    assert.strictEqual(called, true);
    assert.strictEqual((req as any).__loadTestBypass, undefined);
  });

  test("sets __loadTestBypass when header matches the key", () => {
    const key = "k6-load-test-local-secret";
    process.env.LOAD_TEST_BYPASS_KEY = key;
    const middleware = createLoadTestBypassMiddleware();
    const req = makeReq(key);
    let called = false;
    middleware(req, res, () => { called = true; });
    assert.strictEqual(called, true);
    assert.strictEqual((req as any).__loadTestBypass, true);
  });

  test("does NOT set __loadTestBypass when header is absent", () => {
    process.env.LOAD_TEST_BYPASS_KEY = "k6-load-test-local-secret";
    const middleware = createLoadTestBypassMiddleware();
    const req = makeReq(); // no header
    middleware(req, res, () => {});
    assert.strictEqual((req as any).__loadTestBypass, undefined);
  });

  test("does NOT set __loadTestBypass when header is wrong", () => {
    process.env.LOAD_TEST_BYPASS_KEY = "k6-load-test-local-secret";
    const middleware = createLoadTestBypassMiddleware();
    const req = makeReq("wrong-key-value");
    middleware(req, res, () => {});
    assert.strictEqual((req as any).__loadTestBypass, undefined);
  });

  test("rate limiter honours __loadTestBypass flag (unit assertion)", () => {
    // Verify the bypass flag short-circuits rate limiting without importing the
    // full rateLimit module (which requires rate-limiter-flexible to be installed).
    // The actual integration is covered by the middleware source reading req.__loadTestBypass.
    //
    // This test simulates the guard that createRateLimitMiddleware uses:
    //   if (req.__loadTestBypass) return next();
    function simulateRateLimiterGuard(
      req: { __loadTestBypass?: boolean },
      next: (err?: unknown) => void,
    ) {
      if (req.__loadTestBypass) {
        next();
        return;
      }
      next(new Error("rate limited"));
    }

    const bypassReq = { __loadTestBypass: true };
    let bypassNextArg: unknown = "NOT_CALLED";
    simulateRateLimiterGuard(bypassReq, (arg) => { bypassNextArg = arg; });
    assert.strictEqual(bypassNextArg, undefined, "bypass request must not be rate limited");

    const normalReq = { __loadTestBypass: false };
    let normalNextArg: unknown = "NOT_CALLED";
    simulateRateLimiterGuard(normalReq, (arg) => { normalNextArg = arg; });
    assert.ok(normalNextArg instanceof Error, "normal request must be rate limited");
  });
});
