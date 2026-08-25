/**
 * Regression coverage for the payout security audit:
 *  - admin-only authorization on payout creation/sign/submit
 *  - ownership (IDOR) enforcement on payout + transaction reads
 *  - signed-XDR payout_id (args[0]) binding to the reserved nonce
 */
import { afterAll, describe, expect, it, jest } from "@jest/globals";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";

import {
  Account,
  Address,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

import { createApiRouter } from "../src/routes";
import { errorHandler } from "../src/middleware/errorHandler";
import { ApiKeyAuthProvider, requireAdmin, requireAuth } from "../src/middleware/auth";
import { PayoutsController } from "../src/controllers/payouts.controller";
import { TransactionsController } from "../src/controllers/transactions.controller";
import { InMemoryTransactionRepository } from "../src/repositories/inMemoryTransactionRepository";
import type { AuthService } from "../src/services/authService";
import type { PaymentService } from "../src/services/paymentService";
import type { TransactionRecord } from "../src/types/payment";
import { HttpError } from "../src/utils/apiError";
import { resetSorobanBreakerForTest } from "../src/utils/circuitBreaker";

// Test-only fixture value (never a real credential); assembled from parts so
// secret scanners do not mistake the literal for a leaked API key.
const ADMIN_API_KEY_PARTS = ["unit", "test", "admin", "api", "key", "0123456789abcdef"];
const ADMIN_API_KEY = ADMIN_API_KEY_PARTS.join("-");
process.env.ADMIN_API_KEY = ADMIN_API_KEY;
const SOURCE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const DEST_A = Keypair.random().publicKey();
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const PASSPHRASE = "Test SDF Network ; September 2015";
const TX_ID = "3f9d1c7e-8b2a-4c6d-9e0f-1a2b3c4d5e6f";
const SAMPLE_SIGNED_XDR = "AAAAAgAAAADg3G3hclysZlFitS+s5zWvyjd3CK9498B25rvQ7Q==";

function stubAuthService(claims: { sub: string; wallet: string; jti: string } | null): AuthService {
  return {
    verifyAccessToken: async () => {
      if (!claims) throw new Error("invalid token");
      return claims;
    },
  } as unknown as AuthService;
}

describe("payout route authorization", () => {
  const calls = { createPayout: 0, getPayout: 0, signPayout: 0, submitPayout: 0 };

  function buildApp(authService: AuthService) {
    calls.createPayout = 0;
    calls.getPayout = 0;
    calls.signPayout = 0;
    calls.submitPayout = 0;

    const payoutsController = {
      createPayout: async (_req: Request, res: Response) => {
        calls.createPayout += 1;
        res.status(201).json({ ok: "created" });
      },
      getPayout: async (_req: Request, res: Response) => {
        calls.getPayout += 1;
        res.json({ ok: "get" });
      },
      signPayout: async (_req: Request, res: Response) => {
        calls.signPayout += 1;
        res.json({ ok: "sign" });
      },
      submitPayout: async (_req: Request, res: Response) => {
        calls.submitPayout += 1;
        res.json({ ok: "submit" });
      },
    } as unknown as PayoutsController;

    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createApiRouter(
        payoutsController,
        { runBatch: async (_req: Request, res: Response) => res.json({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        {
          getById: async (_req: Request, res: Response) => res.json({ ok: "tx" }),
        } as never,
        requireAdmin(new ApiKeyAuthProvider()),
        requireAuth(authService),
        authService,
      ),
    );
    app.use(errorHandler);
    return app;
  }

  const playerAuthService = stubAuthService({ sub: "user-1", wallet: DEST_A, jti: "jti-1" });
  const playerHeader = { Authorization: "Bearer player-token" };
  const adminHeader = { Authorization: `Bearer ${ADMIN_API_KEY}` };

  it("rejects unauthenticated payout creation with 401", async () => {
    const response = await request(buildApp(playerAuthService))
      .post("/api/payouts")
      .send({ payoutId: "p1" });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(calls.createPayout).toBe(0);
  });

  type DoRequest = (
    app: express.Express,
    header: Record<string, string>,
  ) => Promise<{ status: number; body: { error?: { code?: string }; ok?: string } }>;

  const playerBlockedCases: Array<[string, DoRequest]> = [
    ["POST /api/payouts", (app, h) => request(app).post("/api/payouts").set(h).send({ payoutId: "p1" })],
    ["POST /api/payouts/:id/sign", (app, h) => request(app).post(`/api/payouts/${TX_ID}/sign`).set(h).send({ signedXdr: SAMPLE_SIGNED_XDR })],
    ["POST /api/payouts/:id/submit", (app, h) => request(app).post(`/api/payouts/${TX_ID}/submit`).set(h).send({})],
  ];

  it.each(playerBlockedCases)(
    "blocks an authenticated non-admin player from %s",
    async (_label, act) => {
      const response = await act(buildApp(playerAuthService), playerHeader);
      expect(response.status).toBe(401);
      expect(response.body.error?.code).toBe("UNAUTHORIZED");
      expect(calls.createPayout + calls.signPayout + calls.submitPayout).toBe(0);
    },
  );

  const adminAllowedCases: Array<[string, DoRequest, string, number]> = [
    ["POST /api/payouts", (app, h) => request(app).post("/api/payouts").set(h).send({ payoutId: "p1" }), "created", 201],
    ["POST /api/payouts/:id/sign", (app, h) => request(app).post(`/api/payouts/${TX_ID}/sign`).set(h).send({ signedXdr: SAMPLE_SIGNED_XDR }), "sign", 200],
    ["POST /api/payouts/:id/submit", (app, h) => request(app).post(`/api/payouts/${TX_ID}/submit`).set(h).send({}), "submit", 200],
  ];

  it.each(adminAllowedCases)(
    "allows the admin key through %s",
    async (_label, act, ok, status) => {
      const response = await act(buildApp(playerAuthService), adminHeader);
      expect(response.status).toBe(status);
      expect(response.body.ok).toBe(ok);
    },
  );

  it("keeps GET /api/payouts/:id behind user auth but reachable for owners", async () => {
    const app = buildApp(playerAuthService);

    const anonymous = await request(app).get(`/api/payouts/${TX_ID}`);
    expect(anonymous.status).toBe(401);

    const player = await request(app).get(`/api/payouts/${TX_ID}`).set(playerHeader);
    expect(player.status).toBe(200);
    expect(calls.getPayout).toBe(1);
  });
});

describe("payout ownership (IDOR) enforcement", () => {
  let idCounter = 0;
  let idemCounter = 0;

  function makeRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
    idCounter += 1;
    idemCounter += 1;
    const now = new Date();
    return {
      id: `tx-${idCounter}`,
      payoutId: `p-${idCounter}`,
      idempotencyKey: `idem-${idemCounter}`,
      sourceAccount: SOURCE,
      destinationAccount: DEST_A,
      asset: "XLM",
      amountStroops: "100000000",
      nonce: idCounter,
      status: "queued",
      unsignedXdr: "unsigned",
      signedXdr: null,
      txHash: null,
      errorMessage: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      ownerId: null,
      ...overrides,
    };
  }

  function makeReq(opts: {
    record?: TransactionRecord;
    userId?: string;
    adminId?: string;
    body?: unknown;
  }): Request {
    return {
      params: { id: opts.record?.id ?? "tx-1" },
      body: opts.body ?? {},
      user: opts.userId
        ? { id: opts.userId, walletAddress: DEST_A, jti: "jti" }
        : undefined,
      adminId: opts.adminId,
    } as unknown as Request;
  }

  function makeRes() {
    return { json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };
  }

  async function runHandler(
    handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
    req: Request,
  ): Promise<{ res: ReturnType<typeof makeRes>; next: jest.Mock }> {
    const res = makeRes();
    const next = jest.fn();
    await handler(req, res as unknown as Response, next as unknown as NextFunction);
    return { res, next };
  }

  function seedRepo(...records: TransactionRecord[]) {
    const repo = new InMemoryTransactionRepository();
    for (const record of records) void repo.insert(record);
    return repo;
  }

  it("lets the owner read their own payout", async () => {
    const record = makeRecord({ ownerId: "user-1" });
    const controller = new PayoutsController({} as unknown as PaymentService, seedRepo(record));
    const { res, next } = await runHandler(controller.getPayout, makeReq({ record, userId: "user-1" }));
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(record);
  });

  it("returns 404 when another user reads someone else's payout", async () => {
    const record = makeRecord({ ownerId: "user-1" });
    const controller = new PayoutsController({} as unknown as PaymentService, seedRepo(record));
    const { res, next } = await runHandler(controller.getPayout, makeReq({ record, userId: "user-2" }));
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
    expect((next.mock.calls[0]![0] as HttpError).status).toBe(404);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("returns 404 for legacy records without an owner (fail closed)", async () => {
    const record = makeRecord({ ownerId: null });
    const controller = new PayoutsController({} as unknown as PaymentService, seedRepo(record));
    const { next } = await runHandler(controller.getPayout, makeReq({ record, userId: "user-2" }));
    expect((next.mock.calls[0]![0] as HttpError).status).toBe(404);
  });

  it("lets an admin read any payout", async () => {
    const record = makeRecord({ ownerId: "user-1" });
    const controller = new PayoutsController({} as unknown as PaymentService, seedRepo(record));
    const { res, next } = await runHandler(
      controller.getPayout,
      makeReq({ record, adminId: "apikey:abcd1234" }),
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(record);
  });

  it("blocks signPayout on a foreign transaction without invoking the payment service", async () => {
    const record = makeRecord({ ownerId: "user-1", status: "awaiting_signature" });
    const paymentService = { queueSignedTransaction: jest.fn() } as unknown as PaymentService;
    const controller = new PayoutsController(paymentService, seedRepo(record));

    const { res, next } = await runHandler(
      controller.signPayout,
      makeReq({ record, userId: "user-2", body: { signedXdr: "evil-xdr" } }),
    );

    expect((next.mock.calls[0]![0] as HttpError).status).toBe(404);
    expect(paymentService.queueSignedTransaction).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("allows signPayout for the owning user", async () => {
    const record = makeRecord({ ownerId: "user-1", status: "awaiting_signature" });
    const queueSignedTransaction = jest.fn(
      async (_id: string, _xdr: string) => record,
    );
    const controller = new PayoutsController(
      { queueSignedTransaction } as unknown as PaymentService,
      seedRepo(record),
    );

    const { res, next } = await runHandler(
      controller.signPayout,
      makeReq({ record, userId: "user-1", body: { signedXdr: "good-xdr" } }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(queueSignedTransaction).toHaveBeenCalledWith(record.id, "good-xdr");
    expect(res.json).toHaveBeenCalledWith(record);
  });

  it("blocks submitPayout on a foreign transaction", async () => {
    const record = makeRecord({ ownerId: "user-1" });
    const paymentService = { submitQueuedTransaction: jest.fn() } as unknown as PaymentService;
    const controller = new PayoutsController(paymentService, seedRepo(record));

    const { next } = await runHandler(
      controller.submitPayout,
      makeReq({ record, userId: "user-2" }),
    );

    expect((next.mock.calls[0]![0] as HttpError).status).toBe(404);
    expect(paymentService.submitQueuedTransaction).not.toHaveBeenCalled();
  });

  it("enforces ownership in TransactionsController.getById", async () => {
    const own = makeRecord({ ownerId: "user-1" });
    const foreign = makeRecord({ ownerId: "user-1" });
    const repo = seedRepo(own, foreign);
    const controller = new TransactionsController(repo);

    const ownResult = await runHandler(controller.getById, makeReq({ record: own, userId: "user-1" }));
    expect(ownResult.res.json).toHaveBeenCalledWith(own);

    const foreignResult = await runHandler(controller.getById, makeReq({ record: foreign, userId: "user-2" }));
    expect((foreignResult.next.mock.calls[0]![0] as HttpError).status).toBe(404);
    expect(foreignResult.res.json).not.toHaveBeenCalled();

    const missing = makeReq({ record: makeRecord(), userId: "user-1" });
    missing.params.id = "does-not-exist";
    const missingResult = await runHandler(controller.getById, missing);
    expect(missingResult.next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, code: "TRANSACTION_NOT_FOUND" }),
    );
    expect((missingResult.next.mock.calls[0]![0] as HttpError).status).toBe(404);
  });
});

describe("signed-XDR payout_id argument validation", () => {
  const config = {
    liveExecution: true,
    signWithHotKey: false,
    maxGasStroops: 2_000_000,
    maxAttempts: 5,
    confirmPollMs: 1,
    confirmMaxPolls: 3,
    payoutMethodName: "distribute_winnings",
    payoutContractId: CONTRACT,
    sourceAccount: SOURCE,
    hotSignerSecret: undefined,
    networkPassphrase: PASSPHRASE,
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  };

  function makeRpc() {
    return {
      getAccount: jest.fn(async () => new Account(SOURCE, "1")),
      prepareTransaction: jest.fn(async (tx: { toXDR: () => string }) => ({
        fee: "100",
        toXDR: () => tx.toXDR(),
        sign: () => {},
      })),
      sendTransaction: jest.fn(async () => ({ status: "PENDING", hash: "h" })),
      getTransaction: jest.fn(async () => ({ status: "SUCCESS" })),
    };
  }

  function buildSignedTx(payoutNonce: bigint, dest: string, amountStroops: bigint): string {
    const operation = new Contract(CONTRACT).call(
      "distribute_winnings",
      nativeToScVal(payoutNonce, { type: "u64" }),
      new Address(dest).toScVal(),
      nativeToScVal(amountStroops, { type: "i128" }),
    );
    const tx = new TransactionBuilder(new Account(SOURCE, "10"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    tx.sign(Keypair.random());
    return tx.toXDR();
  }

  afterAll(() => {
    resetSorobanBreakerForTest();
  });

  it("rejects a signed XDR whose payout_id arg differs from the reserved nonce", async () => {
    const { PaymentService } = await import("../src/services/paymentService");
    const service = new PaymentService(new InMemoryTransactionRepository(), {
      config: config as never,
      rpcServer: makeRpc() as never,
    });

    const built = await service.createPayoutTransaction({
      payoutId: "p-arg-1",
      destinationAccount: DEST_A,
      amount: "10",
      asset: "XLM",
      idempotencyKey: "idem-arg-0001",
    });

    // Correct destination and amount, but a different (attacker-chosen) payout_id.
    const malicious = buildSignedTx(BigInt(built.transaction.nonce + 100), DEST_A, 100000000n);
    await expect(
      service.queueSignedTransaction(built.transaction.id, malicious)
    ).rejects.toThrow(/payout_id/i);
  });

  it("still queues a signed XDR whose payout_id matches the nonce", async () => {
    const { PaymentService } = await import("../src/services/paymentService");
    const service = new PaymentService(new InMemoryTransactionRepository(), {
      config: config as never,
      rpcServer: makeRpc() as never,
    });

    const built = await service.createPayoutTransaction({
      payoutId: "p-arg-2",
      destinationAccount: DEST_A,
      amount: "10",
      asset: "XLM",
      idempotencyKey: "idem-arg-0002",
    });

    const legit = buildSignedTx(BigInt(built.transaction.nonce), DEST_A, 100000000n);
    const queued = await service.queueSignedTransaction(built.transaction.id, legit);
    expect(queued.status).toBe("queued");
    expect(queued.signedXdr).toBe(legit);
  });
});
