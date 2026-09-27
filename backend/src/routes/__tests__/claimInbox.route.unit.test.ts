import express from "express";
import request from "supertest";
import type { RequestHandler } from "express";

import { errorHandler } from "../../middleware/errorHandler";
import { InMemoryTransactionRepository } from "../../repositories/inMemoryTransactionRepository";
import type { TransactionRecord } from "../../types/payment";

/**
 * The router pulls in the real on-chain verifier, which reaches across into the
 * frontend package for its RPC gateway. The backend cannot compile that file,
 * so the module is replaced rather than loaded. This suite is about the
 * route's own contract — auth, ownership, bounds — not about RPC.
 */
jest.mock("../../services/claimInboxVerifier", () => ({
  verifyArenasOnChain: jest.fn(async () => new Map()),
}));
jest.mock("../../services/cancellationRecoveryService", () => ({
  CancellationRecoveryService: jest.fn(() => ({ getArenaRecovery: async () => null })),
}));
jest.mock("../../config/stellarConfig", () => ({
  getStellarConfig: () => ({ assetIssuers: {} }),
  NATIVE_ASSET_CODE: "XLM",
}));

// Imported after the mocks so the router sees the replacements.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createClaimInboxRouter } = require("../claimInbox") as typeof import("../claimInbox");

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ARENA_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const T0 = new Date("2026-09-27T10:00:00.000Z");

let nonce = 0;

function payout(over: Partial<TransactionRecord> & { payoutId: string }): TransactionRecord {
  nonce += 1;
  return {
    id: `p${nonce}`,
    idempotencyKey: `idem-${nonce}`,
    sourceAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    destinationAccount: WALLET,
    asset: "XLM",
    amountStroops: "100000000",
    nonce,
    status: "built",
    unsignedXdr: "xdr",
    attempts: 1,
    createdAt: T0,
    updatedAt: T0,
    confirmedAt: null,
    ...over,
  } as TransactionRecord;
}

function authFor(walletAddress: string | null): RequestHandler {
  return (req, _res, next) => {
    if (walletAddress) {
      (req as unknown as { user: unknown }).user = { id: "user-1", walletAddress };
    }
    next();
  };
}

async function buildApp(
  records: TransactionRecord[],
  authMiddleware: RequestHandler,
): Promise<express.Express> {
  const repo = new InMemoryTransactionRepository();
  for (const record of records) await repo.insert(record);
  const app = express();
  app.use("/api/users", createClaimInboxRouter({} as never, authMiddleware, repo));
  app.use(errorHandler);
  return app;
}

describe("GET /api/users/me/claim-inbox", () => {
  it("rejects an unauthenticated request", async () => {
    const app = await buildApp([payout({ payoutId: ARENA_A })], authFor(null));

    const res = await request(app).get("/api/users/me/claim-inbox");

    expect(res.status).toBe(401);
  });

  it("returns the caller's own positions", async () => {
    const app = await buildApp([payout({ payoutId: ARENA_A })], authFor(WALLET));

    const res = await request(app).get("/api/users/me/claim-inbox");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.walletAddress).toBe(WALLET);
  });

  it("never returns another wallet's positions", async () => {
    // A record belonging to someone else, requested by this wallet.
    const app = await buildApp(
      [payout({ payoutId: ARENA_A, destinationAccount: OTHER_WALLET })],
      authFor(WALLET),
    );

    const res = await request(app).get("/api/users/me/claim-inbox");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("ignores a wallet supplied as a query parameter", async () => {
    // Ownership is taken from the session only. If this ever became honoured,
    // the endpoint would be an open balance disclosure.
    const app = await buildApp(
      [payout({ payoutId: ARENA_A, destinationAccount: OTHER_WALLET })],
      authFor(WALLET),
    );

    const res = await request(app).get(
      `/api/users/me/claim-inbox?walletAddress=${OTHER_WALLET}&destinationAccount=${OTHER_WALLET}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("is not cacheable by a shared cache", async () => {
    const app = await buildApp([payout({ payoutId: ARENA_A })], authFor(WALLET));

    const res = await request(app).get("/api/users/me/claim-inbox");

    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers.vary).toContain("Authorization");
  });

  it("rejects a limit outside the allowed range", async () => {
    const app = await buildApp([payout({ payoutId: ARENA_A })], authFor(WALLET));

    expect((await request(app).get("/api/users/me/claim-inbox?limit=0")).status).toBe(400);
    expect((await request(app).get("/api/users/me/claim-inbox?limit=51")).status).toBe(400);
    expect((await request(app).get("/api/users/me/claim-inbox?limit=-1")).status).toBe(400);
    expect((await request(app).get("/api/users/me/claim-inbox?limit=abc")).status).toBe(400);
  });

  it("caps a large limit rather than serving the whole table", async () => {
    const records: TransactionRecord[] = [];
    for (let i = 0; i < 60; i += 1) {
      records.push(
        payout({ payoutId: `C${String(i).padStart(55, "0").slice(0, 55)}` }),
      );
    }
    const app = await buildApp(records, authFor(WALLET));

    const res = await request(app).get("/api/users/me/claim-inbox?limit=50");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(50);
    expect(res.body.hasMore).toBe(true);
  });

  it("rejects an oversized cursor instead of parsing it", async () => {
    const app = await buildApp([payout({ payoutId: ARENA_A })], authFor(WALLET));

    const res = await request(app).get(`/api/users/me/claim-inbox?cursor=${"x".repeat(513)}`);

    expect(res.status).toBe(400);
  });
});
