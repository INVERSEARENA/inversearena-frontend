import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { validateBody, validateParams } from "../src/middleware/validate";
import {
  SignPayoutBodySchema,
  TransactionIdParamSchema,
} from "../src/validation/requestValidation";

function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Partial<Request>
): unknown {
  let capturedError: unknown;

  middleware(req as Request, {} as Response, (error?: unknown) => {
    capturedError = error;
  });

  return capturedError;
}

test("validateParams(TransactionIdParamSchema) rejects invalid id", () => {
  const middleware = validateParams(TransactionIdParamSchema);
  const req = { params: { id: "not-a-valid-id" } };

  const error = runMiddleware(middleware, req);

  assert.ok(error instanceof ZodError);
});

test("validateParams(TransactionIdParamSchema) accepts UUID id", () => {
  const middleware = validateParams(TransactionIdParamSchema);
  const req = { params: { id: "c8ba1cac-5722-4f57-bc60-24f3b51022cd" } };

  const error = runMiddleware(middleware, req);

  assert.equal(error, undefined);
  assert.equal(req.params?.id, "c8ba1cac-5722-4f57-bc60-24f3b51022cd");
});

test("validateBody(SignPayoutBodySchema) rejects missing signedXdr", () => {
  const middleware = validateBody(SignPayoutBodySchema);
  const req = { body: {} };

  const error = runMiddleware(middleware, req);

  assert.ok(error instanceof ZodError);
});

test("validateBody(SignPayoutBodySchema) rejects short signedXdr", () => {
  const middleware = validateBody(SignPayoutBodySchema);
  const req = { body: { signedXdr: "short" } };

  const error = runMiddleware(middleware, req);

  assert.ok(error instanceof ZodError);
});

test("validateBody(SignPayoutBodySchema) accepts valid signedXdr", () => {
  const middleware = validateBody(SignPayoutBodySchema);
  const req = { body: { signedXdr: "A".repeat(20) } };

  const error = runMiddleware(middleware, req);

  assert.equal(error, undefined);
  assert.equal(req.body?.signedXdr, "A".repeat(20));
});
