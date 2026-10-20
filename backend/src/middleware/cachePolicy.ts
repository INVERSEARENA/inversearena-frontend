import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * CDN edge-cache policy for the backend's public reads (#1626).
 *
 * Two concerns are deliberately separated here:
 *
 *  1. `publicCache` sets a browser/CDN `Cache-Control` that lets a shared cache
 *     store the response and serve it while the backend revalidates in the
 *     background (`stale-while-revalidate`). This is what removes anonymous
 *     traffic from the origin, and it is only ever applied to responses that
 *     are byte-for-byte identical for every caller.
 *
 *  2. `privateNoStore` (applied globally in app.ts) is the default for every
 *     response that was not explicitly marked public. Personalized or
 *     authenticated data must never land in a shared cache, so the safe
 *     default is "do not store". A route opts *in* to being cacheable; nothing
 *     is cached by omission.
 *
 * `publicCache` also refuses to emit a shared-cache header when the request
 * carried credentials (`Authorization` header or a session cookie). A CDN in
 * front of the app may be configured to ignore cookies, so the guard is
 * enforced in code rather than relying on cache configuration: an
 * authenticated request never gets a cacheable directive even if a misrouted
 * client reaches a public handler with a bearer token.
 */

export interface PublicCacheOptions {
  /** Seconds a cache may serve the response without revalidating. */
  maxAge: number;
  /** Seconds a cache may keep serving stale after `maxAge` while revalidating. */
  staleWhileRevalidate: number;
  /**
   * Seconds a cache may keep serving stale if it cannot reach the origin at
   * all. Optional; omitted from the header when undefined.
   */
  staleIfError?: number;
}

/** Builds the `Cache-Control` value for a public, shareable response. */
export function buildPublicCacheControl(options: PublicCacheOptions): string {
  const directives = [
    "public",
    `max-age=${options.maxAge}`,
    "must-revalidate",
    `stale-while-revalidate=${options.staleWhileRevalidate}`,
  ];
  if (options.staleIfError !== undefined) {
    directives.push(`stale-if-error=${options.staleIfError}`);
  }
  return directives.join(", ");
}

/** True when the request carries credentials that make a shared cache unsafe. */
export function requestIsPersonalized(req: Request): boolean {
  if (typeof req.headers.authorization === "string" && req.headers.authorization.length > 0) {
    return true;
  }
  const cookie = req.headers.cookie;
  return typeof cookie === "string" && cookie.length > 0;
}

/**
 * Sets a shared-cache `Cache-Control` header for a public read. Emits the
 * header only when the request is anonymous; a personalized request is left
 * for the global `privateNoStore` default.
 */
export function publicCache(options: PublicCacheOptions): RequestHandler {
  const value = buildPublicCacheControl(options);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!requestIsPersonalized(req)) {
      res.setHeader("Cache-Control", value);
    }
    next();
  };
}

/**
 * Default response policy: nothing is stored by a shared or private cache
 * unless a route explicitly opted in with `publicCache`.
 */
export function privateNoStore(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!res.getHeader("Cache-Control")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  };
}
