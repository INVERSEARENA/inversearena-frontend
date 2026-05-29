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

    const expected =
      "sha256=" +
      createHmac("sha256", secret)
        .update(JSON.stringify(req.body))
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
