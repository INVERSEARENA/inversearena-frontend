import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { apiError } from "../utils/apiError";

export function verifyWebhookSignature(secret: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers["x-oracle-signature"] as string | undefined;
    if (!signature) {
      next(apiError(401, "WEBHOOK_SIGNATURE_MISSING", "Missing webhook signature"));
      return;
    }

    if (!req.rawBody) {
      // Only happens if this middleware is ever wired up on a route not
      // behind the express.json({ verify }) parser mounted for /api/oracle
      // in app.ts — a wiring bug, not a caller error, so this is a 500 not
      // a 401.
      next(apiError(500, "WEBHOOK_RAW_BODY_MISSING", "Raw request body was not captured"));
      return;
    }

    const expected =
      "sha256=" +
      createHmac("sha256", secret)
        .update(req.rawBody)
        .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      next(apiError(401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature"));
      return;
    }

    next();
  };
}
