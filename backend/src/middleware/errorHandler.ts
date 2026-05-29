import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError, defaultErrorCode, type ApiError } from "../utils/apiError";
import { logger, reportErrorToSentry } from "../utils/logger";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    const body: ApiError = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation error",
        issues: err.issues,
      },
    };
    res.status(400).json(body);
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? 500;
  const code = err instanceof HttpError || status < 500
    ? typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : defaultErrorCode(status)
    : defaultErrorCode(status);

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

  const body: ApiError = {
    error: {
      code,
      message,
    },
  };
  res.status(status).json(body);
};
