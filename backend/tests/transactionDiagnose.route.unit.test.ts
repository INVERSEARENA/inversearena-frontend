/**
 * Integration test for POST /api/transactions/:id/diagnose (#1400). Uses
 * the same access-policy fixture pattern as transactionAccess.enumeration.test.ts
 * so diagnose gets identical enumeration-resistance coverage to the
 * existing status/timeline endpoints, without duplicating that policy's
 * own unit tests.
 */
jest.mock("../src/services/transactionDiagnosticsService", () => ({
  diagnoseTransaction: jest.fn(),
}));

import { describe, expect, it, jest as jestGlobal, beforeEach } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

import { TransactionsController } from "../src/controllers/transactions.controller";
import { errorHandler } from "../src/middleware/errorHandler";
import { InMemoryTransactionRepository } from "../src/repositories/inMemoryTransactionRepository";
import { createTransactionsRouter } from "../src/routes/transactions";
import { diagnoseTransaction } from "../src/services/transactionDiagnosticsService";
import type { TransactionRecord } from "../src/types/payment";
import { TRANSACTION_NOT_FOUND_CODE } from "../src/utils/transactionAccess";

const mockedDiagnoseTransaction = diagnoseTransaction as jest.MockedFunction<typeof diagnoseTransaction>;

const OWN_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ID = "22222222-2222-4222-8222-222222222222";
const ABSENT_ID = "44444444-4444-4444-8444-444444444444";

function makeRecord(overrides: Partial<TransactionRecord>): TransactionRecord {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: OWN_ID,
    payoutId: "payout-a",
    idempotencyKey: `idem-${overrides.id ?? OWN_ID}`,
    sourceAccount: "GSOURCE",
    destinationAccount: "GDEST",
    asset: "XLM",
    amountStroops: "100",
    nonce: 1,
    status: "queued",
    unsignedXdr: "unsigned-xdr-blob",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ownerId: "user-1",
    ...overrides,
  };
}

function seedRepo(...records: TransactionRecord[]) {
  const repo = new InMemoryTransactionRepository();
  for (const record of records) void repo.insert(record);
  return repo;
}

function buildApp(repo: InMemoryTransactionRepository) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const user = req.header("x-test-user");
    if (user) req.user = { id: user, walletAddress: "G", jti: "j" };
    next();
  });
  app.use("/api/transactions", createTransactionsRouter(new TransactionsController(repo)));
  app.use(errorHandler);
  return app;
}

describe("POST /api/transactions/:id/diagnose", () => {
  beforeEach(() => {
    mockedDiagnoseTransaction.mockReset();
  });

  it("returns diagnostics for the owner's transaction", async () => {
    const repo = seedRepo(makeRecord({ id: OWN_ID, ownerId: "user-1" }));
    mockedDiagnoseTransaction.mockResolvedValue({
      outcome: "would_succeed",
      contractCode: null,
      remediation: null,
      footprint: { minResourceFeeStroops: "1000", readEntries: 1, writeEntries: 1 },
      latestLedger: 100,
    });

    const res = await request(buildApp(repo))
      .post(`/api/transactions/${OWN_ID}/diagnose`)
      .set("x-test-user", "user-1");

    expect(res.status).toBe(200);
    expect(res.body.transactionId).toBe(OWN_ID);
    expect(res.body.outcome).toBe("would_succeed");
    expect(mockedDiagnoseTransaction).toHaveBeenCalledWith("unsigned-xdr-blob");
  });

  it("returns 404 for a foreign owner's transaction, matching absent's shape", async () => {
    const repo = seedRepo(makeRecord({ id: FOREIGN_ID, ownerId: "user-2" }));
    const app = buildApp(repo);

    const [absent, foreign] = await Promise.all([
      request(app).post(`/api/transactions/${ABSENT_ID}/diagnose`).set("x-test-user", "user-1"),
      request(app).post(`/api/transactions/${FOREIGN_ID}/diagnose`).set("x-test-user", "user-1"),
    ]);

    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe(TRANSACTION_NOT_FOUND_CODE);
    const shape = (res: request.Response, id: string) => JSON.stringify(res.body).replace(id, "<id>");
    expect(shape(foreign, FOREIGN_ID)).toBe(shape(absent, ABSENT_ID));
    expect(mockedDiagnoseTransaction).not.toHaveBeenCalled();
  });

  it("propagates a diagnostics service failure as a 5xx, not a 404", async () => {
    const repo = seedRepo(makeRecord({ id: OWN_ID, ownerId: "user-1" }));
    mockedDiagnoseTransaction.mockRejectedValue(new Error("rpc unavailable"));

    const res = await request(buildApp(repo))
      .post(`/api/transactions/${OWN_ID}/diagnose`)
      .set("x-test-user", "user-1");

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("never submits or mutates the transaction: status is unchanged after diagnose", async () => {
    const repo = seedRepo(makeRecord({ id: OWN_ID, ownerId: "user-1", status: "queued" }));
    mockedDiagnoseTransaction.mockResolvedValue({
      outcome: "would_succeed",
      contractCode: null,
      remediation: null,
      footprint: { minResourceFeeStroops: "1000", readEntries: 0, writeEntries: 0 },
      latestLedger: 1,
    });

    const app = buildApp(repo);
    await request(app).post(`/api/transactions/${OWN_ID}/diagnose`).set("x-test-user", "user-1");

    const after = await request(app).get(`/api/transactions/${OWN_ID}`).set("x-test-user", "user-1");
    expect(after.body.status).toBe("queued");
  });
});
