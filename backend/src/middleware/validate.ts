import type { Request, Response, NextFunction, RequestHandler } from "express";

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
