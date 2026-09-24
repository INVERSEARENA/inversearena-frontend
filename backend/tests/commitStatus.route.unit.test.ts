import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { createArenasRouter } from "../src/routes/arenas";
import { errorHandler } from "../src/middleware/errorHandler";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/cache/redisClient";

/**
 * Unlike tests/arenas.route.unit.test.ts's 404 case (which the route
 * formats with a direct res.status(404).json(...)), the commit-status route
 * (and most other routes in arenas.ts) formats failures by `throw
 * apiError(...)` and relies on Express's error-handling chain — exactly as
 * production does via app.use(errorHandler) in src/app.ts. Building the
 * test app here mirrors that: without it, thrown HttpErrors would fall
 * through to Express's built-in handler, which returns an empty JSON body.
 */
function buildApp(authMiddleware: express.RequestHandler): express.Express {
  const app = express();
  app.use("/api/arenas", createArenasRouter(authMiddleware));
  app.use(errorHandler);
  return app;
}

/**
 * Route-level tests for GET /api/arenas/:id/rounds/:roundNumber/commit-status
 * (#1383). Matches the style of tests/arenas.route.unit.test.ts: mocks the
 * prisma surface the router touches and drives the router through supertest,
 * exercising the router -> RoundService -> RoundRepository/prisma.user flow
 * end to end (the "cross-module flow" for this feature).
 */

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX";

function authMiddlewareFor(wallet: string | undefined) {
  return (req: any, res: any, next: any) => {
    if (!wallet) {
      res.status(401).json({ error: { code: "UNAUTHORIZED" } });
      return;
    }
    req.user = { id: "user-1", walletAddress: wallet, jti: "jti-1" };
    next();
  };
}

const originalArena = prisma.arena;
const originalRound = prisma.round;
const originalUser = prisma.user;

test.afterEach(() => {
  prisma.arena = originalArena;
  prisma.round = originalRound;
  prisma.user = originalUser;
  redis.disconnect();
});

function mockArena(exists: boolean) {
  prisma.arena = {
    findUnique: async () => (exists ? { id: "arena-1" } : null),
  } as any;
}

test("GET /:id/rounds/:roundNumber/commit-status requires authentication", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(undefined));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/commit-status");

  assert.strictEqual(response.status, 401);
  assert.deepStrictEqual(response.body, { error: { code: "UNAUTHORIZED" } });
});

test("GET /:id/rounds/:roundNumber/commit-status returns 404 when the arena does not exist", async () => {
  mockArena(false);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/missing-arena/rounds/1/commit-status");

  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.body.error.code, "ARENA_NOT_FOUND");
});

test("GET /:id/rounds/:roundNumber/commit-status rejects a non-integer roundNumber with 400 VALIDATION_ERROR", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/not-a-number/commit-status");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error.code, "VALIDATION_ERROR");
});

test("GET /:id/rounds/:roundNumber/commit-status rejects roundNumber=0 (below the min) with 400", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/0/commit-status");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error.code, "VALIDATION_ERROR");
});

test("GET /:id/rounds/:roundNumber/commit-status rejects an oversized roundNumber with 400", async () => {
  mockArena(true);
  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/99999999/commit-status");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error.code, "VALIDATION_ERROR");
});

test("GET /:id/rounds/:roundNumber/commit-status returns 200 missing/ROUND_NOT_FOUND when the round doesn't exist", async () => {
  mockArena(true);
  prisma.round = { findUnique: async () => null } as any;

  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/commit-status");

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, "missing");
  assert.strictEqual(response.body.reason, "ROUND_NOT_FOUND");
  assert.strictEqual(response.body.walletAddress, WALLET);
  assert.strictEqual(typeof response.body.asOf, "string");
});

test("GET /:id/rounds/:roundNumber/commit-status returns 200 accepted when the round resolved with the caller's choice", async () => {
  mockArena(true);
  prisma.round = {
    findUnique: async () => ({
      id: "round-1",
      arenaId: "arena-1",
      roundNumber: 1,
      state: "RESOLVED",
      metadata: { playerChoices: [{ userId: "user-1", choice: "heads", stake: 100 }] },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  } as any;
  prisma.user = { findUnique: async () => ({ id: "user-1", walletAddress: WALLET }) } as any;

  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/commit-status");

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, "accepted");
  assert.strictEqual(response.body.choice, "heads");
});

test("GET /:id/rounds/:roundNumber/commit-status returns 200 pending while the round is OPEN with no recorded choice", async () => {
  mockArena(true);
  prisma.round = {
    findUnique: async () => ({
      id: "round-1",
      arenaId: "arena-1",
      roundNumber: 1,
      state: "OPEN",
      metadata: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  } as any;
  prisma.user = { findUnique: async () => ({ id: "user-1", walletAddress: WALLET }) } as any;

  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/commit-status");

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, "pending");
});

test("GET /:id/rounds/:roundNumber/commit-status returns 200 expired when the round is CLOSED with no recorded choice", async () => {
  mockArena(true);
  prisma.round = {
    findUnique: async () => ({
      id: "round-1",
      arenaId: "arena-1",
      roundNumber: 1,
      state: "CLOSED",
      metadata: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  } as any;
  prisma.user = { findUnique: async () => ({ id: "user-1", walletAddress: WALLET }) } as any;

  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/commit-status");

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, "expired");
});

test("GET /:id/rounds/:roundNumber/commit-status only ever reports the authenticated caller's own status (ownership)", async () => {
  // Round has choices for two different players; caller (user-1) matches
  // only one of them. The response must reflect user-1's status, not leak
  // or be confused by user-2's entry.
  mockArena(true);
  prisma.round = {
    findUnique: async () => ({
      id: "round-1",
      arenaId: "arena-1",
      roundNumber: 1,
      state: "RESOLVED",
      metadata: {
        playerChoices: [
          { userId: "user-2", choice: "tails", stake: 50 },
        ],
      },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  } as any;
  prisma.user = { findUnique: async () => ({ id: "user-1", walletAddress: WALLET }) } as any;

  const app = buildApp(authMiddlewareFor(WALLET));

  const response = await request(app).get("/api/arenas/arena-1/rounds/1/commit-status");

  assert.strictEqual(response.status, 200);
  // user-1 has no entry -> resolved round with no recorded choice -> missing
  assert.strictEqual(response.body.status, "missing");
  assert.strictEqual(response.body.reason, "NO_COMMIT_RECORDED");
});

test("GET /:id/rounds/:roundNumber/commit-status handles concurrent requests independently", async () => {
  mockArena(true);
  prisma.round = {
    findUnique: async () => ({
      id: "round-1",
      arenaId: "arena-1",
      roundNumber: 1,
      state: "OPEN",
      metadata: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  } as any;
  prisma.user = { findUnique: async () => ({ id: "user-1", walletAddress: WALLET }) } as any;

  const app = buildApp(authMiddlewareFor(WALLET));

  const [r1, r2, r3] = await Promise.all([
    request(app).get("/api/arenas/arena-1/rounds/1/commit-status"),
    request(app).get("/api/arenas/arena-1/rounds/1/commit-status"),
    request(app).get("/api/arenas/arena-1/rounds/1/commit-status"),
  ]);

  for (const response of [r1, r2, r3]) {
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, "pending");
  }
});
