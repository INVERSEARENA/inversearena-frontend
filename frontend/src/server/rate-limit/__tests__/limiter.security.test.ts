/**
 * Regression tests for #1297.
 *
 * 1. resolveClientIp used to trust the first hop of X-Forwarded-For
 *    unconditionally, so a direct caller could set an arbitrary value per
 *    request and get a fresh rate-limit bucket every time — trivially
 *    bypassing the /auth/nonce and /pools limits.
 * 2. When REDIS_URL is unset the limiter silently falls back to per-process
 *    in-memory limiting with no startup warning.
 */
import type { NextRequest } from "next/server";

import {
  UNTRUSTED_CLIENT_BUCKET,
  consumeRateLimit,
  getTrustedProxyCount,
  resolveClientIp,
  warnOnInsecureRateLimitConfig,
} from "../limiter";
import type { RouteRateLimitConfig } from "../config";

function req(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveClientIp X-Forwarded-For trust (#1297)", () => {
  it("ignores X-Forwarded-For entirely when no trusted proxy is configured", () => {
    delete process.env.TRUSTED_PROXY_COUNT;

    expect(getTrustedProxyCount()).toBe(0);
    expect(resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe(
      UNTRUSTED_CLIENT_BUCKET,
    );
    expect(resolveClientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe(
      UNTRUSTED_CLIENT_BUCKET,
    );
  });

  it("with one trusted proxy, ignores a value the caller prepends", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";

    // Honest: proxy appends the real peer as the only entry.
    expect(resolveClientIp(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");

    // Spoofed: caller sent "6.6.6.6", the trusted proxy appended their real
    // peer 203.0.113.7 — we must resolve to the peer, not the spoof.
    expect(
      resolveClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" })),
    ).toBe("203.0.113.7");
    expect(
      resolveClientIp(req({ "x-forwarded-for": "7.7.7.7, 203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

  it("with two trusted proxies, resolves the peer left of the two appended hops", () => {
    process.env.TRUSTED_PROXY_COUNT = "2";

    expect(
      resolveClientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.9, 10.0.0.1" })),
    ).toBe("198.51.100.9");
  });

  it("falls back to X-Real-IP only once behind a trusted proxy", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    expect(resolveClientIp(req({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");

    // Header shorter than the trusted chain → not trusted, fall through.
    process.env.TRUSTED_PROXY_COUNT = "3";
    expect(
      resolveClientIp(
        req({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.5" }),
      ),
    ).toBe("198.51.100.5");
  });
});

describe("rate-limit bucket cannot be reset by spoofing X-Forwarded-For (#1297)", () => {
  it("blocks after the threshold even when every request carries a different spoofed IP", async () => {
    delete process.env.TRUSTED_PROXY_COUNT;
    delete process.env.REDIS_URL;

    const config: RouteRateLimitConfig = {
      keyPrefix: `test:spoof:${Date.now()}`,
      points: 2,
      durationSeconds: 60,
    };

    const first = await consumeRateLimit({
      config,
      request: req({ "x-forwarded-for": "1.1.1.1" }),
    });
    const second = await consumeRateLimit({
      config,
      request: req({ "x-forwarded-for": "2.2.2.2" }),
    });
    const third = await consumeRateLimit({
      config,
      request: req({ "x-forwarded-for": "3.3.3.3" }),
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Before the fix, the third request's fresh spoofed IP would have minted a
    // brand-new bucket and been allowed too.
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("warnOnInsecureRateLimitConfig (#1297)", () => {
  it("warns about both the in-memory fallback and the ignored X-Forwarded-For", () => {
    delete process.env.REDIS_URL;
    delete process.env.TRUSTED_PROXY_COUNT;
    const logger = { warn: jest.fn() };

    warnOnInsecureRateLimitConfig(logger);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /REDIS_URL/,
    );
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /TRUSTED_PROXY_COUNT/,
    );
  });

  it("stays silent when Redis and a trusted-proxy count are both configured", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.TRUSTED_PROXY_COUNT = "1";
    const logger = { warn: jest.fn() };

    warnOnInsecureRateLimitConfig(logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
