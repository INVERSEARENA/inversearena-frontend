import express from "express";
import request from "supertest";
import { test, afterEach } from "node:test";
import assert from "node:assert";
import { createArenasRouter } from "../src/routes/arenas";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/cache/redisClient";

/**
 * sync-players authorisation (#1351).
 *
 * The route used to require nothing but a valid user JWT, so any logged-in
 * wallet could drive a live Soroban simulateTransaction plus DB writes for any
 * arena id in the system — an authenticated amplification vector against the
 * RPC with no ownership relationship to the arena being synced.
 */

// Raise the sync-players budget so the authorisation assertions in this file are
// not masked by the rate limiter (which is exercised separately below).
process.env.RATE_LIMIT_SYNC_PLAYERS_POINTS = "1000";

const OWNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const STRANGER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const originalArena = prisma.arena;
const originalUser = prisma.user;
const originalAdminWallets = process.env.ADMIN_WALLET_ADDRESSES;

afterEach(() => {
  prisma.arena = originalArena;
  prisma.user = originalUser;
  if (originalAdminWallets === undefined) delete process.env.ADMIN_WALLET_ADDRESSES;
  else process.env.ADMIN_WALLET_ADDRESSES = originalAdminWallets;
  redis.disconnect();
});

/** Build an app whose auth middleware authenticates `walletAddress`. */
function buildApp(walletAddress: string) {
  const authMiddleware = (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", walletAddress, jti: "jti-1" };
    next();
  };

  const app = express();
  app.use(express.json());
  app.use("/api/arenas", createArenasRouter(authMiddleware));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ code: err.code, message: err.message });
  });
  return app;
}

function stubArena(createdBy: string | undefined) {
  prisma.arena = {
    findUnique: async () => ({
      id: "arena-1",
      metadata: { contractAddress: CONTRACT, ...(createdBy ? { createdBy } : {}) },
    }),
  } as any;

  // If authorisation ever let a caller through, this would be the write it
  // reached — failing loudly is better than silently succeeding.
  prisma.user = {
    createMany: async () => {
      throw new Error("sync must not reach the database for an unauthorised caller");
    },
  } as any;
}

test("a non-owner, non-admin caller is rejected with 403", async () => {
  stubArena(OWNER);
  process.env.ADMIN_WALLET_ADDRESSES = "";

  const res = await request(buildApp(STRANGER)).post("/api/arenas/arena-1/sync-players");

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, "FORBIDDEN");
});

test("rejection happens before any Soroban or database work", async () => {
  stubArena(OWNER);
  process.env.ADMIN_WALLET_ADDRESSES = "";

  // prisma.user.createMany throws if reached; a 403 proves it was not.
  const res = await request(buildApp(STRANGER)).post("/api/arenas/arena-1/sync-players");

  assert.strictEqual(res.status, 403);
  assert.ok(!("totalPlayers" in res.body), "must not return a sync result");
});

test("an arena with no recorded creator is not syncable by an arbitrary user", async () => {
  stubArena(undefined);
  process.env.ADMIN_WALLET_ADDRESSES = "";

  const res = await request(buildApp(STRANGER)).post("/api/arenas/arena-1/sync-players");

  // Missing ownership metadata must fail closed, not open.
  assert.strictEqual(res.status, 403);
});

test("a missing arena still returns 404, not 403", async () => {
  prisma.arena = { findUnique: async () => null } as any;

  const res = await request(buildApp(STRANGER)).post("/api/arenas/missing/sync-players");

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, "ARENA_NOT_FOUND");
});

test("the owner passes the authorisation gate", async () => {
  stubArena(OWNER);
  process.env.ADMIN_WALLET_ADDRESSES = "";

  const res = await request(buildApp(OWNER)).post("/api/arenas/arena-1/sync-players");

  // Past the gate it proceeds to the on-chain read, which is not stubbed here —
  // any status other than 403 shows authorisation allowed the owner through.
  assert.notStrictEqual(res.status, 403);
});

test("an admin wallet passes the authorisation gate for an arena it does not own", async () => {
  stubArena(OWNER);
  process.env.ADMIN_WALLET_ADDRESSES = STRANGER;

  const res = await request(buildApp(STRANGER)).post("/api/arenas/arena-1/sync-players");

  assert.notStrictEqual(res.status, 403);
});

test("the route is rate limited once the budget is spent", async () => {
  stubArena(OWNER);
  process.env.ADMIN_WALLET_ADDRESSES = "";
  process.env.RATE_LIMIT_SYNC_PLAYERS_POINTS = "2";
  process.env.RATE_LIMIT_SYNC_PLAYERS_PREFIX = `rl:test:${Date.now()}`;

  const app = buildApp(STRANGER);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await request(app).post("/api/arenas/arena-1/sync-players");
    statuses.push(res.status);
  }

  // Unbounded RPC amplification was the point of the issue: the budget must run
  // out rather than every call reaching Soroban.
  assert.ok(
    statuses.includes(429),
    `expected a 429 once the budget was spent, saw ${statuses.join(",")}`,
  );

  process.env.RATE_LIMIT_SYNC_PLAYERS_POINTS = "1000";
  delete process.env.RATE_LIMIT_SYNC_PLAYERS_PREFIX;
});
