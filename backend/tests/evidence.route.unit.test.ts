import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { createArenasRouter } from "../src/routes/arenas";
import { errorHandler } from "../src/middleware/errorHandler";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/cache/redisClient";

/**
 * Route-level tests for GET /api/arenas/:id/rounds/:roundNumber/evidence
 * (#1517). Matches the style of tests/commitStatus.route.unit.test.ts: mocks
 * the prisma surface the router (and the services it composes — RoundService,
 * RoundProofBundleService, CancellationRecoveryService) touch, and drives the
 * router through supertest.
 */

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX";
const USER_ID = "user-1";

function authMiddlewareFor(wallet: string | undefined) {
  return (req: any, _res: any, next: any) => {
    if (!wallet) {
      req.user = undefined;
      next();
      return;
    }
    req.user = { id: USER_ID, walletAddress: wallet, jti: "jti-1" };
    next();
  };
}

function buildApp(authMiddleware: express.RequestHandler): express.Express {
  const app = express();
  app.use("/api/arenas", createArenasRouter(authMiddleware));
  app.use(errorHandler);
  return app;
}

const originalArena = prisma.arena;
const originalRound = prisma.round;
const originalUser = prisma.user;
const originalEliminationLog = prisma.eliminationLog;

test.afterEach(() => {
  prisma.arena = originalArena;
  prisma.round = originalRound;
  prisma.user = originalUser;
  prisma.eliminationLog = originalEliminationLog;
  redis.disconnect();
});

function mockArena(exists: boolean) {
  prisma.arena = {
    findUnique: async () => (exists ? { id: "arena-1", metadata: { contractAddress: "CARENA00000000000000000000000000000000000000000000000" } } : null),
  } as any;
}

function mockNoElimination() {
  prisma.eliminationLog = { findFirst: async () => null } as any;
}

test("GET /:id/rounds/:roundNumber/evidence requires authentication", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(undefined));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/evidence");

  assert.strictEqual(response.status, 401);
});

test("GET /:id/rounds/:roundNumber/evidence rejects a caller-supplied walletAddress override with 400", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/evidence?walletAddress=someone-else");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error.code, "EVIDENCE_SCOPE_NOT_OVERRIDABLE");
});

test("GET /:id/rounds/:roundNumber/evidence rejects a caller-supplied userId override with 400", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/evidence?userId=someone-else");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error.code, "EVIDENCE_SCOPE_NOT_OVERRIDABLE");
});

test("GET /:id/rounds/:roundNumber/evidence returns 404 ARENA_NOT_FOUND when the arena does not exist", async () => {
  mockArena(false);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/missing-arena/rounds/1/evidence");

  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.body.error.code, "ARENA_NOT_FOUND");
});

test("GET /:id/rounds/:roundNumber/evidence returns 404 ROUND_NOT_FOUND when the round does not exist", async () => {
  mockArena(true);
  prisma.round = { findUnique: async () => null } as any;
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/evidence");

  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.body.error.code, "ROUND_NOT_FOUND");
});

test("GET /:id/rounds/:roundNumber/evidence returns 403 for a wallet with no footprint in the round (cross-wallet access)", async () => {
  mockArena(true);
  mockNoElimination();
  prisma.round = {
    findUnique: async () => ({
      id: "round-1",
      arenaId: "arena-1",
      roundNumber: 1,
      state: "RESOLVED",
      metadata: { playerChoices: [{ userId: "someone-else", choice: "heads", stake: 100 }] },
      oracleYield: 5,
      randomSeed: null,
      playerChoices: [{ userId: "someone-else", choice: "heads", stake: 100 }],
      allActivePlayerIds: ["someone-else"],
      resolution: { eliminatedPlayers: [], payouts: [], poolBalances: {} },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  } as any;
  prisma.user = { findUnique: async () => ({ id: USER_ID, walletAddress: WALLET }) } as any;

  const app = buildApp(authMiddlewareFor(WALLET));
  const response = await request(app).get("/api/arenas/arena-1/rounds/1/evidence");

  assert.strictEqual(response.status, 403);
  assert.strictEqual(response.body.error.code, "EVIDENCE_NOT_PARTICIPANT");
});

test("GET /:id/rounds/:roundNumber/evidence rejects a malformed roundNumber with 400 before touching the database", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/-5/evidence");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error.code, "VALIDATION_ERROR");
});

test("GET /:id/rounds/:roundNumber/evidence returns a checksummed package for a participant", async () => {
  mockArena(true);
  mockNoElimination();
  prisma.round = {
    findUnique: async () => ({
      id: "round-1",
      arenaId: "arena-1",
      roundNumber: 1,
      state: "RESOLVED",
      metadata: { playerChoices: [{ userId: USER_ID, choice: "heads", stake: 100 }] },
      oracleYield: 5,
      randomSeed: "a".repeat(64),
      playerChoices: [{ userId: USER_ID, choice: "heads", stake: 100 }],
      allActivePlayerIds: [USER_ID],
      resolution: { eliminatedPlayers: [], payouts: [], poolBalances: {} },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  } as any;
  prisma.user = { findUnique: async () => ({ id: USER_ID, walletAddress: WALLET }) } as any;

  const app = buildApp(authMiddlewareFor(WALLET));
  const response = await request(app).get("/api/arenas/arena-1/rounds/1/evidence");

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.success, true);
  assert.strictEqual(typeof response.body.data.checksum, "string");
  assert.strictEqual(response.body.data.schemaVersion, 1);
  assert.strictEqual(response.body.data.player.userId, USER_ID);
});
