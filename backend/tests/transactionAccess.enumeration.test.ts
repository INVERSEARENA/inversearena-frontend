/**
 * #1454 — transaction status endpoints must not allow cross-wallet
 * enumeration: absent and unauthorized records produce identical responses.
 */
import { describe, expect, it, jest } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

import { TransactionsController } from "../src/controllers/transactions.controller";
import { errorHandler } from "../src/middleware/errorHandler";
import { InMemoryTransactionRepository } from "../src/repositories/inMemoryTransactionRepository";
import { createTransactionsRouter } from "../src/routes/transactions";
import type { TransactionRecord } from "../src/types/payment";
import { HttpError } from "../src/utils/apiError";
import { register } from "../src/utils/metrics";
import {
  evaluateTransactionAccess,
  filterAccessibleTransactions,
  loadAccessibleTransaction,
  transactionNotFound,
  TRANSACTION_NOT_FOUND_CODE,
} from "../src/utils/transactionAccess";

const OWN_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ID = "22222222-2222-4222-8222-222222222222";
const LEGACY_ID = "33333333-3333-4333-8333-333333333333";
const ABSENT_ID = "44444444-4444-4444-8444-444444444444";
const SIBLING_ID = "55555555-5555-4555-8555-555555555555";

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
    unsignedXdr: "xdr",
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

function fakeReq(principal: { userId?: string; adminId?: string }, id = OWN_ID): Request {
  return {
    params: { id },
    user: principal.userId ? { id: principal.userId, walletAddress: "G", jti: "j" } : undefined,
    adminId: principal.adminId,
  } as unknown as Request;
}

describe("evaluateTransactionAccess", () => {
  const own = makeRecord({});
  it("allows the owner and admins", () => {
    expect(evaluateTransactionAccess(own, { userId: "user-1" })).toEqual({ allowed: true, reason: "owner" });
    expect(evaluateTransactionAccess(own, { adminId: "key-1" })).toEqual({ allowed: true, reason: "admin" });
  });

  it("denies with distinct server-side reasons", () => {
    expect(evaluateTransactionAccess(null, { userId: "user-1" }).reason).toBe("absent");
    expect(evaluateTransactionAccess(own, {}).reason).toBe("unauthenticated");
    expect(evaluateTransactionAccess(own, { userId: "user-2" }).reason).toBe("foreign_owner");
    expect(evaluateTransactionAccess(makeRecord({ ownerId: null }), { userId: "user-1" }).reason).toBe("legacy_unowned");
  });

  it("never matches an empty-string owner to an empty-string user id", () => {
    expect(evaluateTransactionAccess(makeRecord({ ownerId: "" }), { userId: "" }).allowed).toBe(false);
  });

  it("does not grant admin access to an absent record", () => {
    expect(evaluateTransactionAccess(undefined, { adminId: "key-1" })).toEqual({ allowed: false, reason: "absent" });
  });
});

describe("loadAccessibleTransaction", () => {
  const repo = seedRepo(makeRecord({}), makeRecord({ id: FOREIGN_ID, ownerId: "user-2" }));

  it("returns the owned record", async () => {
    await expect(loadAccessibleTransaction(repo, OWN_ID, fakeReq({ userId: "user-1" }), "status")).resolves.toMatchObject({ id: OWN_ID });
  });

  it("throws structurally identical errors for absent and foreign ids", async () => {
    const absent = await loadAccessibleTransaction(repo, ABSENT_ID, fakeReq({ userId: "user-1" }), "status").catch((e) => e as HttpError);
    const foreign = await loadAccessibleTransaction(repo, FOREIGN_ID, fakeReq({ userId: "user-1" }), "status").catch((e) => e as HttpError);
    expect(absent).toBeInstanceOf(HttpError);
    expect(foreign).toBeInstanceOf(HttpError);
    const normalize = (e: HttpError, id: string) => ({ status: e.status, code: e.code, message: e.message.replace(id, "<id>") });
    expect(normalize(foreign as HttpError, FOREIGN_ID)).toEqual(normalize(absent as HttpError, ABSENT_ID));
    expect(foreign).toEqual(transactionNotFound(FOREIGN_ID));
  });

  it("propagates repository failures instead of masking them as 404 (retry path)", async () => {
    let calls = 0;
    const flaky = {
      findById: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("mongo unavailable");
        return makeRecord({});
      }),
    };
    const req = fakeReq({ userId: "user-1" });
    await expect(loadAccessibleTransaction(flaky, OWN_ID, req, "status")).rejects.toThrow("mongo unavailable");
    await expect(loadAccessibleTransaction(flaky, OWN_ID, req, "status")).resolves.toMatchObject({ id: OWN_ID });
  });

  it("records allowed/denied decisions in metrics", async () => {
    await loadAccessibleTransaction(repo, FOREIGN_ID, fakeReq({ userId: "user-9" }), "metrics_probe").catch(() => undefined);
    const metrics = await register.getSingleMetricAsString("inversearena_transaction_access_decisions_total");
    expect(metrics).toContain('operation="metrics_probe",outcome="denied",reason="foreign_owner"');
  });
});

describe("filterAccessibleTransactions", () => {
  it("drops foreign and legacy siblings for users but keeps all for admins", () => {
    const records = [makeRecord({}), makeRecord({ id: FOREIGN_ID, ownerId: "user-2" }), makeRecord({ id: LEGACY_ID, ownerId: null })];
    expect(filterAccessibleTransactions(records, fakeReq({ userId: "user-1" })).map((r) => r.id)).toEqual([OWN_ID]);
    expect(filterAccessibleTransactions(records, fakeReq({ adminId: "k" }))).toHaveLength(3);
  });
});

describe("transaction status routes (integration)", () => {
  // Two wallets deliberately share a caller-supplied payoutId.
  const repo = seedRepo(
    makeRecord({ id: OWN_ID, ownerId: "user-1", payoutId: "shared" }),
    makeRecord({ id: SIBLING_ID, ownerId: "user-1", payoutId: "shared", createdAt: new Date("2026-01-02T00:00:00Z") }),
    makeRecord({ id: FOREIGN_ID, ownerId: "user-2", payoutId: "shared", createdAt: new Date("2026-01-03T00:00:00Z") }),
    makeRecord({ id: LEGACY_ID, ownerId: null, payoutId: "legacy" }),
  );

  function buildApp() {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const user = req.header("x-test-user");
      if (user) (req as Request).user = { id: user, walletAddress: "G", jti: "j" } as Request["user"];
      next();
    });
    app.use("/api/transactions", createTransactionsRouter(new TransactionsController(repo)));
    app.use(errorHandler);
    return app;
  }

  const app = buildApp();
  const probe = (path: string) => request(app).get(path).set("x-test-user", "user-1");

  const endpoints: Array<[string, (id: string) => string]> = [
    ["status", (id) => `/api/transactions/${id}`],
    ["timeline", (id) => `/api/transactions/${id}/timeline`],
  ];
  it.each(endpoints)("%s: absent, foreign and legacy ids are indistinguishable", async (_name, path) => {
    const [absent, foreign, legacy] = await Promise.all([probe(path(ABSENT_ID)), probe(path(FOREIGN_ID)), probe(path(LEGACY_ID))]);
    for (const res of [absent, foreign, legacy]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(TRANSACTION_NOT_FOUND_CODE);
    }
    const shape = (res: request.Response, id: string) => JSON.stringify(res.body).replace(id, "<id>");
    expect(shape(foreign, FOREIGN_ID)).toBe(shape(absent, ABSENT_ID));
    expect(shape(legacy, LEGACY_ID)).toBe(shape(absent, ABSENT_ID));
    expect(Object.keys(foreign.headers).sort()).toEqual(Object.keys(absent.headers).sort());
  });

  it("serves the owner's status", async () => {
    const res = await probe(`/api/transactions/${OWN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(OWN_ID);
  });

  it("timeline excludes another wallet's record sharing the payoutId", async () => {
    const res = await probe(`/api/transactions/${OWN_ID}/timeline`);
    expect(res.status).toBe(200);
    const ids = (res.body.timeline as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual([OWN_ID, SIBLING_ID]);
    expect(JSON.stringify(res.body)).not.toContain(FOREIGN_ID);
  });

  it("rejects malformed ids before any lookup (invalid input)", async () => {
    const res = await probe("/api/transactions/not-a-valid-id");
    expect(res.status).toBe(400);
  });

  it("concurrent probes all receive the same opaque 404", async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => probe(`/api/transactions/${i % 2 ? FOREIGN_ID : ABSENT_ID}`)));
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([404]));
  });
});
