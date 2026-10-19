/**
 * Regression coverage for #1214: the webhook HMAC must be computed over the
 * exact bytes the sender signed (req.rawBody), not JSON.stringify(req.body).
 * Re-serializing an already-parsed object is not guaranteed to reproduce the
 * sender's original byte sequence (number formatting, key order, whitespace),
 * which would make a legitimately-signed request fail verification.
 */
import { describe, expect, it } from "@jest/globals";
import { createHmac } from "crypto";
import type { Request, Response } from "express";

import { verifyWebhookSignature } from "../src/middleware/verifyWebhook";

const SECRET = "test-webhook-secret";

function sign(rawBody: Buffer): string {
  return "sha256=" + createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

function buildReqRes(rawBody: Buffer, signature: string | undefined) {
  const req = {
    headers: signature ? { "x-oracle-signature": signature } : {},
    rawBody,
  } as unknown as Request;
  const res = {} as Response;
  let nextArg: unknown;
  const next = (err?: unknown) => {
    nextArg = err;
  };
  return { req, res, next, getNextArg: () => nextArg };
}

describe("verifyWebhookSignature (#1214)", () => {
  it("accepts a signature computed over the raw bytes even when key order differs from JSON.stringify(req.body)", () => {
    // A sender that serializes keys in a different order than
    // JSON.stringify would produce from the parsed object — the classic
    // case the old JSON.stringify(req.body)-based verification broke on.
    const rawBody = Buffer.from('{"asset":"USDY","currentAPY":5.5}');
    const signature = sign(rawBody);

    const { req, res, next, getNextArg } = buildReqRes(rawBody, signature);
    verifyWebhookSignature(SECRET)(req, res, next);

    expect(getNextArg()).toBeUndefined();
  });

  it("rejects a signature that does not match the raw body", () => {
    const rawBody = Buffer.from('{"asset":"USDY"}');
    const wrongSignature = sign(Buffer.from('{"asset":"DIFFERENT"}'));

    const { req, res, next, getNextArg } = buildReqRes(rawBody, wrongSignature);
    verifyWebhookSignature(SECRET)(req, res, next);

    const err = getNextArg() as { status: number; code: string };
    expect(err.status).toBe(401);
    expect(err.code).toBe("WEBHOOK_SIGNATURE_INVALID");
  });

  it("rejects when the signature header is missing", () => {
    const rawBody = Buffer.from('{"asset":"USDY"}');

    const { req, res, next, getNextArg } = buildReqRes(rawBody, undefined);
    verifyWebhookSignature(SECRET)(req, res, next);

    const err = getNextArg() as { status: number; code: string };
    expect(err.status).toBe(401);
    expect(err.code).toBe("WEBHOOK_SIGNATURE_MISSING");
  });

  it("rejects with a 500 (not 401) when rawBody was never captured", () => {
    // Wiring bug guard: if this middleware is ever attached to a route not
    // behind the express.json({ verify }) parser, fail loudly rather than
    // silently falling back to a re-serialized body.
    const signature = sign(Buffer.from('{"asset":"USDY"}'));
    const { req, res, next, getNextArg } = buildReqRes(undefined as unknown as Buffer, signature);
    verifyWebhookSignature(SECRET)(req, res, next);

    const err = getNextArg() as { status: number; code: string };
    expect(err.status).toBe(500);
    expect(err.code).toBe("WEBHOOK_RAW_BODY_MISSING");
  });
});
