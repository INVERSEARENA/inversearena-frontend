import {
  UNTRUSTED_CLIENT_BUCKET,
  buildRateLimitRejection,
  consumeRateLimitByKey,
  resolveClientIp,
} from "../limiter";
import type { RouteRateLimitConfig } from "../config";

function createConfig(prefix: string, points: number, durationSeconds: number): RouteRateLimitConfig {
  return {
    keyPrefix: prefix,
    points,
    durationSeconds,
  };
}

describe("Rate Limiter unit tests", () => {
  it("blocks after threshold and reports retry delay", async () => {
    const config = createConfig("test:nonce:block", 2, 2);
    const key = "ip:127.0.0.1:wallet:test";

    const first = await consumeRateLimitByKey({ config, key });
    const second = await consumeRateLimitByKey({ config, key });
    const third = await consumeRateLimitByKey({ config, key });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("window reset allows requests again after duration", async () => {
    const config = createConfig("test:pools:reset", 1, 1);
    const key = "ip:127.0.0.1";

    const allowed = await consumeRateLimitByKey({ config, key });
    const blocked = await consumeRateLimitByKey({ config, key });
    expect(allowed.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const afterReset = await consumeRateLimitByKey({ config, key });
    expect(afterReset.allowed).toBe(true);
  });

  it("resolveClientIp ignores X-Forwarded-For when no trusted proxy is configured (#1297)", () => {
    delete process.env.TRUSTED_PROXY_COUNT;

    expect(
      resolveClientIp({ headers: new Headers({ "x-forwarded-for": "1.2.3.4" }) }),
    ).toBe(UNTRUSTED_CLIENT_BUCKET);
    expect(
      resolveClientIp({ headers: new Headers({ "x-forwarded-for": "5.6.7.8" }) }),
    ).toBe(UNTRUSTED_CLIENT_BUCKET);
  });

  it("resolveClientIp ignores a client-prepended X-Forwarded-For hop behind one trusted proxy (#1297)", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    try {
      expect(
        resolveClientIp({
          headers: new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }),
        }),
      ).toBe("203.0.113.9");
      expect(
        resolveClientIp({
          headers: new Headers({ "x-forwarded-for": "203.0.113.9" }),
        }),
      ).toBe("203.0.113.9");
    } finally {
      delete process.env.TRUSTED_PROXY_COUNT;
    }
  });

  it("returns 429 response with Retry-After when request is rate-limited", async () => {
    const config = createConfig("test:nonce:response", 1, 1);
    const request = {
      headers: new Headers({ "x-forwarded-for": "127.0.0.1" }),
    };

    const first = await buildRateLimitRejection({ config, request });
    const second = await buildRateLimitRejection({ config, request });

    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(second?.status).toBe(429);
    const retryAfter = Number(second?.headers.get("Retry-After") ?? "0");
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});
