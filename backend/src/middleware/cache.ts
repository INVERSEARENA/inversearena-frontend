import type { Request, Response, NextFunction, RequestHandler } from "express";
import { cache } from "../cache/cacheService";

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
        // Cache in background — don't block the response
        cache.set(key, body, ttlSeconds).catch(() => {});
      }

      return originalJson(body);
    };

    next();
  };
}
