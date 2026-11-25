import { createExpressRateLimitMiddleware } from "../src/adapters/express";
import { consumeNextRateLimit, buildNextRateLimitRejection } from "../src/adapters/next";
import { clearLimiterCache } from "../src/limiter";

describe("Rate Limit Adapters", () => {
  beforeEach(() => {
    clearLimiterCache();
  });

  describe("Express Adapter", () => {
    it("allows requests under the limit and calls next()", async () => {
      const middleware = createExpressRateLimitMiddleware({
        keyPrefix: "rl:test:express:allow",
        points: 2,
        durationSeconds: 60,
      });

      const req: any = {
        headers: { "x-real-ip": "10.0.0.1" },
        body: {},
      };
      const res: any = {
        set: jest.fn(),
      };
      const next = jest.fn();

      process.env.TRUSTED_PROXY_COUNT = "1";
      await middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(res.set).not.toHaveBeenCalled();
    });

    it("blocks requests over limit and sets Retry-After", async () => {
      const middleware = createExpressRateLimitMiddleware({
        keyPrefix: "rl:test:express:block",
        points: 1,
        durationSeconds: 60,
      });

      const req: any = {
        headers: { "x-real-ip": "10.0.0.2" },
        body: {},
      };
      const res: any = {
        set: jest.fn(),
      };
      const next = jest.fn();

      process.env.TRUSTED_PROXY_COUNT = "1";
      // 1st consumption: allowed
      await middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();

      // 2nd consumption: blocked
      const nextBlocked = jest.fn();
      await middleware(req, res, nextBlocked);
      expect(res.set).toHaveBeenCalledWith("Retry-After", expect.any(String));
      expect(nextBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 429,
          code: "RATE_LIMITED",
        }),
      );
    });
  });

  describe("Next.js Adapter", () => {
    it("allows request under limit", async () => {
      process.env.TRUSTED_PROXY_COUNT = "1";
      const request = {
        headers: {
          get: (name: string) => (name.toLowerCase() === "x-real-ip" ? "10.0.0.3" : null),
        },
      };

      const result = await consumeNextRateLimit({
        policyOrConfig: {
          keyPrefix: "rl:test:next:allow",
          points: 2,
          durationSeconds: 60,
        },
        request,
      });

      expect(result.allowed).toBe(true);
      expect(result.retryAfterSeconds).toBe(0);
    });

    it("builds 429 response when limit is exceeded", async () => {
      process.env.TRUSTED_PROXY_COUNT = "1";
      const request = {
        headers: {
          get: (name: string) => (name.toLowerCase() === "x-real-ip" ? "10.0.0.4" : null),
        },
      };

      const config = {
        keyPrefix: "rl:test:next:block",
        points: 1,
        durationSeconds: 60,
      };

      // 1st request consumes point
      const res1 = await buildNextRateLimitRejection({ policyOrConfig: config, request });
      expect(res1).toBeNull();

      // 2nd request is rejected
      const res2 = await buildNextRateLimitRejection({ policyOrConfig: config, request });
      expect(res2).not.toBeNull();
      expect(res2?.status).toBe(429);
      expect(res2?.headers.get("Retry-After")).toBeDefined();
    });
  });
});
