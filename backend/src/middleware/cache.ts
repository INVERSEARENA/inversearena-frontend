import { createHash } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { cache } from "../cache/cacheService";

/**
 * Derives a deterministic weak ETag from a serialised response body.
 * SHA-1 is used purely as a fast fingerprint — not for security.
 */
function generateETag(serialized: string): string {
  return `"${createHash("sha1").update(serialized).digest("hex").slice(0, 20)}"`;
}

type KeyGenerator = (req: Request) => string;

/**
 * Express middleware that caches JSON responses in Redis.
 *
 * On cache hit: returns cached response immediately.
 * On cache miss: intercepts res.json(), caches the result, then sends it.
 */
export function cacheMiddleware(keyGen: KeyGenerator, ttlSeconds: number): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = keyGen(req);

    try {
      const cached = await cache.get<unknown>(key);
      if (cached !== null) {
        const etag = generateETag(JSON.stringify(cached));
        res.setHeader("ETag", etag);
        if (req.headers["if-none-match"] === etag) {
          res.status(304).end();
          return;
        }
        res.setHeader("X-Cache", "HIT");
        res.json(cached);
        return;
      }
    } catch {
      // Redis down — fall through to handler
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      res.setHeader("X-Cache", "MISS");

      // Only cache successful responses. res.json is also what the global
      // error handler calls (res.status(4xx/5xx).json(...)), so without this
      // check a single transient failure gets cached and replayed to every
      // subsequent request for the full TTL window.
      if (res.statusCode < 300) {
        const serialized = JSON.stringify(body);
        res.setHeader("ETag", generateETag(serialized));
        // Cache in background — don't block the response
        cache.set(key, body, ttlSeconds).catch(() => {});
      }

      return originalJson(body);
    };

    next();
  };
}
