import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export function verifyWebhookSignature(secret: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers["x-oracle-signature"] as string | undefined;
    if (!signature) {
      res.status(401).json({ error: "Missing webhook signature" });
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
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    next();
  };
}
