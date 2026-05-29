import type { Request, Response, NextFunction } from "express";
import { runWithRequestContext } from "../utils/requestContext";

/**
 * Binds the request's correlation id into AsyncLocalStorage for the lifetime of
 * the request (#661). Must be mounted *after* the pino-http request logger,
 * which assigns `req.id` from an inbound `X-Request-ID` header or a fresh UUID.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId =
    (req.id as string | undefined) ?? (req.headers["x-request-id"] as string | undefined) ?? "";
  // Echo it back so clients can quote it when reporting an issue.
  if (requestId) res.setHeader("X-Request-Id", requestId);
  runWithRequestContext({ requestId }, () => next());
}
