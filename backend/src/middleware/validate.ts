import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodType } from "zod";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Wraps an async route handler so that any thrown error is forwarded to
 * Express's next(err).
 *
 * Express 5 (#1837): async handlers that throw or return a rejected promise are
 * forwarded to the error handler automatically — this wrapper is a no-op
 * pass-through kept only for backward compatibility with call sites that still
 * reference it.  It can be removed in a follow-up once all callers have been
 * updated, but removing it now would cause a larger diff than the issue requires.
 */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  // Express 5 propagates rejected async handlers natively; no .catch(next) needed.
  return fn;
}

/**
 * Validates and normalizes req.body using a Zod schema.
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body) as unknown;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validates and normalizes req.params using a Zod schema.
 */
export function validateParams<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    try {
      req.params = schema.parse(req.params) as unknown as Request["params"];
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validates and normalizes req.query using a Zod schema.
 *
 * Express 5 (#1837): `req.query` is defined as a getter backed by the router's
 * query parser and cannot be assigned directly.  Parsed values are stored on
 * `res.locals.query` so downstream handlers can access the validated/coerced
 * result without touching the read-only property.
 *
 * Usage: `const q = res.locals.query as T` in the route handler after this
 * middleware.  Alternatively, the validated value is also written back to
 * `req.query` via `Object.defineProperty` when the runtime allows it
 * (Express 4 integration tests), making both access patterns work.
 */
export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.query);
      // Store on res.locals for Express 5 (req.query getter is read-only).
      res.locals["query"] = parsed;
      // Best-effort assignment for backward compat with Express 4 callers.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).query = parsed;
      } catch {
        // Silently ignore — Express 5 throws on this assignment; res.locals.query is the canonical path.
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
