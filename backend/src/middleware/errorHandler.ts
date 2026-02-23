import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger, reportErrorToSentry } from "../utils/logger";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation error",
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";
  const status = (err as { status?: number }).status ?? 500;

  if (status >= 500) {
    logger.error({ err, reqId: req.id, url: req.url, method: req.method }, "Unhandled Server Error");

    // Attempt extracting context tags from request data
    const context: Record<string, any> = {
      requestId: req.id,
      url: req.url,
      method: req.method,
    };
    if (req.body?.arenaId) context.arenaId = req.body.arenaId;
    if (req.body?.poolId) context.poolId = req.body.poolId;
    if (req.body?.userWallet) context.userWallet = req.body.userWallet;

    reportErrorToSentry(err instanceof Error ? err : new Error(message), context);
  } else {
    logger.warn({ err, reqId: req.id, url: req.url, method: req.method }, "Client Error");
  }

  res.status(status).json({ error: message, requestId: req.id });
};
