import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { apiError } from "../utils/apiError";
import {
  fingerprintKid,
  recordVerification,
  verificationCandidates,
  type SecretKeyring,
} from "../config/secretKeyring";

/** Optional header naming which key signed the webhook (#1456). */
export const WEBHOOK_KEY_ID_HEADER = "x-oracle-key-id";

function toKeyring(secretOrKeyring: string | SecretKeyring): SecretKeyring {
  if (typeof secretOrKeyring !== "string") return secretOrKeyring;
  return { purpose: "webhook", current: { kid: fingerprintKid(secretOrKeyring), secret: secretOrKeyring, slot: "current" } };
}

function signatureMatches(secret: string, rawBody: Buffer, sigBuf: Buffer): boolean {
  const expBuf = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
}

/**
 * Verify the oracle webhook HMAC. Accepts a single secret (legacy callers)
 * or a rotation keyring: during an overlap window the previous key is still
 * accepted, but a sender naming an unknown kid via `x-oracle-key-id` is
 * rejected outright rather than tried against every key.
 */
export function verifyWebhookSignature(secretOrKeyring: string | SecretKeyring): RequestHandler {
  const keyring = toKeyring(secretOrKeyring);
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

    const rawKid = req.headers[WEBHOOK_KEY_ID_HEADER];
    const kid = typeof rawKid === "string" && rawKid.length > 0 ? rawKid : undefined;
    const candidates = verificationCandidates(keyring, kid);
    if (candidates.length === 0) {
      recordVerification("webhook", "unknown_kid", "none", kid);
      // Same status/code as a bad signature: do not reveal which kids exist.
      next(apiError(401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature"));
      return;
    }

    const sigBuf = Buffer.from(signature);
    const matched = candidates.find((key) => signatureMatches(key.secret, req.rawBody!, sigBuf));
    if (!matched) {
      recordVerification("webhook", "bad_signature", "none", kid);
      next(apiError(401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature"));
      return;
    }

    recordVerification("webhook", "accepted", matched.slot, kid);
    next();
  };
}
