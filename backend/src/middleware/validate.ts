import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodType } from "zod";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Wraps an async route handler so that any thrown error is forwarded to
 * Express's next(err) — avoiding unhandled promise rejections.
 */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
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
