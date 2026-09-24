import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { PayoutsController } from "../src/controllers/payouts.controller";
import type { TransactionRecord } from "../src/types/payment";

function baseTransaction(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: "tx-1",
    payoutId: "payout-1",
    idempotencyKey: "idem-1",
    sourceAccount: "GSOURCE",
    destinationAccount: "GDEST",
    asset: "XLM",
    amountStroops: "1270000000",
    nonce: 1,
    status: "confirmed",
    unsignedXdr: "AAAA",
    signedXdr: "AAAA",
    txHash: "a".repeat(64),
    errorMessage: null,
    attempts: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    confirmedAt: new Date(),
    ownerId: "user-1",
    principal: 100,
    yieldAmount: 30,
    platformFee: 3,
    dust: 0,
    ...overrides,
  };
}

function buildApp(transaction: TransactionRecord | null, userId = "user-1") {
  const transactions = {
    findById: async (_id: string) => transaction,
  } as any;
  const controller = new PayoutsController({} as any, transactions);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: userId, walletAddress: "GWALLET", jti: "jti-1" };
    next();
  });
  app.get("/payouts/:id/receipt", (req, res, next) => {
    controller.getReceipt(req as any, res as any, next).catch(next);
  });
  app.get("/payouts/:id/receipt.csv", (req, res, next) => {
    controller.getReceiptCsv(req as any, res as any, next).catch(next);
  });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });

  return app;
}

test("getReceipt: returns a reconciling manifest for a confirmed, owned payout", async () => {
  const app = buildApp(baseTransaction());
  const res = await request(app).get("/payouts/tx-1/receipt");

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.principal, 100);
  assert.strictEqual(res.body.yieldAmount, 30);
  assert.strictEqual(res.body.platformFee, 3);
  assert.ok(Math.abs(res.body.netPayout - 127) < 1e-6);
  assert.strictEqual(res.body.txHash, "a".repeat(64));
});

test("getReceipt: 409s when the payout has not yet confirmed on-chain", async () => {
  const app = buildApp(baseTransaction({ status: "submitted", txHash: null, confirmedAt: null }));
  const res = await request(app).get("/payouts/tx-1/receipt");

  assert.strictEqual(res.status, 409);
});

test("getReceipt: 404s for a payout owned by a different user (IDOR)", async () => {
  const app = buildApp(baseTransaction({ ownerId: "someone-else" }));
  const res = await request(app).get("/payouts/tx-1/receipt");

  assert.strictEqual(res.status, 404);
});

test("getReceipt: 404s for an unknown transaction id", async () => {
  const app = buildApp(null);
  const res = await request(app).get("/payouts/missing/receipt");

  assert.strictEqual(res.status, 404);
});

test("getReceiptCsv: downloads a CSV with an attachment content-disposition", async () => {
  const app = buildApp(baseTransaction());
  const res = await request(app).get("/payouts/tx-1/receipt.csv");

  assert.strictEqual(res.status, 200);
  assert.match(res.headers["content-type"], /text\/csv/);
  assert.match(res.headers["content-disposition"], /attachment; filename="receipt-payout-1\.csv"/);
  assert.match(res.text, /^payoutId,recipient,asset/);
});

test("getReceiptCsv: sanitizes a payoutId containing header-unsafe characters", async () => {
  const app = buildApp(baseTransaction({ payoutId: 'payout"; evil\r\nX-Injected: 1' }));
  const res = await request(app).get("/payouts/tx-1/receipt.csv");

  assert.strictEqual(res.status, 200);
  assert.ok(!res.headers["content-disposition"].includes("\r"));
  assert.ok(!res.headers["content-disposition"].includes('"; evil'));
});
