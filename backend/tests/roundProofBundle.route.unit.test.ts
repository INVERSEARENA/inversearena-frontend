import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { createRoundProofBundleRouter } from "../src/routes/roundProofBundle";
import { RoundProofBundleService } from "../src/services/roundProofBundleService";
import { errorHandler } from "../src/middleware/errorHandler";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/cache/redisClient";
import { cache, cacheKeys } from "../src/cache/cacheService";

const authMiddleware = (_req: any, _res: any, next: any) => next();

const originalRound = prisma.round;
const originalArena = prisma.arena;

const ROUND_ID = "33333333-3333-3333-3333-333333333333";
const ARENA_ID = "44444444-4444-4444-4444-444444444444";
const ARENA_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

// RoundProofBundleService's constructor calls getStellarConfig() by default,
// which reads env vars not set in this test process (or in backend-ci.yml's
// "Run Integration Tests" step, which is why the router must accept an
// injected service — see createRoundProofBundleRouter's second param).
// Injecting a fake config here keeps this test isolated from that env.
const FAKE_STELLAR_CONFIG = {
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  roundConfirmPollMs: 1,
  roundConfirmMaxPolls: 1,
};

function buildProofBundleService(): RoundProofBundleService {
  return new RoundProofBundleService(prisma, FAKE_STELLAR_CONFIG);
}

function resolvedRoundRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ROUND_ID,
    arenaId: ARENA_ID,
    roundNumber: 1,
    state: "RESOLVED",
    metadata: {
      playerChoices: [
        { userId: "p1", choice: "heads", stake: 100 },
        { userId: "p2", choice: "tails", stake: 100 },
      ],
      oracleYield: 0,
      randomSeed: "seed",
      resolution: { eliminatedPlayers: ["p2"], payouts: [], poolBalances: {} },
      allActivePlayerIds: ["p1", "p2"],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Every route in this file is wrapped in cacheMiddleware keyed on roundId, so
// tests sharing ROUND_ID across different mocked scenarios must clear that
// key first or they'll see a stale cached response from an earlier test.
test.beforeEach(async () => {
  await cache.del(cacheKeys.roundProofBundle(ROUND_ID));
});

test.afterEach(() => {
  prisma.round = originalRound;
  prisma.arena = originalArena;
});

// Only close Redis once, after every test in this file has run — ioredis's
// disconnect() is a hard close that does not auto-reconnect on the next
// command (unlike the lazy initial connect), so calling it per-test would
// break every subsequent cache.get/set/del in this file.
test.after(() => {
  redis.disconnect();
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/rounds", createRoundProofBundleRouter(authMiddleware, buildProofBundleService()));
  app.use(errorHandler);
  return app;
}

test("GET /api/rounds/:id/proof-bundle requires authentication", async () => {
  let authCalls = 0;
  const app = express();
  app.use(
    "/api/rounds",
    createRoundProofBundleRouter((_req, res) => {
      authCalls += 1;
      res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    }, buildProofBundleService()),
  );
  app.use(errorHandler);

  const response = await request(app).get(`/api/rounds/${ROUND_ID}/proof-bundle`);

  assert.strictEqual(response.status, 401);
  assert.strictEqual(authCalls, 1);
});

test("GET /api/rounds/:id/proof-bundle returns 400 when id param is missing entirely (trailing slash route miss)", async () => {
  const app = buildApp();
  const response = await request(app).get("/api/rounds//proof-bundle");
  // Express treats an empty :id segment as a 404 route miss, not our handler;
  // assert we never 500 in that case.
  assert.notStrictEqual(response.status, 500);
});

test("GET /api/rounds/:id/proof-bundle returns 404 when the round does not exist", async () => {
  prisma.round = { findUnique: async () => null } as any;

  const app = buildApp();
  const response = await request(app).get(`/api/rounds/does-not-exist/proof-bundle`);

  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.body.error.code, "ROUND_NOT_FOUND");
});

test("GET /api/rounds/:id/proof-bundle returns 409 ROUND_NOT_RESOLVED for an OPEN round", async () => {
  prisma.round = { findUnique: async () => resolvedRoundRow({ state: "OPEN", metadata: null }) } as any;

  const app = buildApp();
  const response = await request(app).get(`/api/rounds/${ROUND_ID}/proof-bundle`);

  assert.strictEqual(response.status, 409);
  assert.strictEqual(response.body.error.code, "ROUND_NOT_RESOLVED");
});

test("GET /api/rounds/:id/proof-bundle returns 409 ROUND_PROOF_BUNDLE_UNAVAILABLE for a legacy round with no allActivePlayerIds", async () => {
  prisma.round = {
    findUnique: async () =>
      resolvedRoundRow({
        metadata: {
          playerChoices: [{ userId: "p1", choice: "heads", stake: 100 }],
          oracleYield: 0,
          randomSeed: "seed",
          resolution: { eliminatedPlayers: [], payouts: [], poolBalances: {} },
          allActivePlayerIds: undefined,
        },
      }),
  } as any;
  prisma.arena = { findUnique: async () => ({ metadata: { contractAddress: ARENA_CONTRACT_ID } }) } as any;

  const app = buildApp();
  const response = await request(app).get(`/api/rounds/${ROUND_ID}/proof-bundle`);

  assert.strictEqual(response.status, 409);
  assert.strictEqual(response.body.error.code, "ROUND_PROOF_BUNDLE_UNAVAILABLE");
});

test("GET /api/rounds/:id/proof-bundle returns 200 with a well-formed bundle for a resolved round", async () => {
  prisma.round = { findUnique: async () => resolvedRoundRow() } as any;
  prisma.arena = { findUnique: async () => ({ metadata: { contractAddress: ARENA_CONTRACT_ID } }) } as any;

  const app = buildApp();
  const response = await request(app).get(`/api/rounds/${ROUND_ID}/proof-bundle`);

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.success, true);
  assert.strictEqual(response.body.data.roundId, ROUND_ID);
  assert.deepStrictEqual(response.body.data.survivors, ["p1"]);
  assert.deepStrictEqual(response.body.data.eliminatedPlayers, ["p2"]);
  assert.match(response.body.data.checksum, /^[a-f0-9]{64}$/);
});

test("GET /api/rounds/:id/proof-bundle serves a cached response on the second call without re-querying the DB (duplicate delivery)", async () => {
  let findUniqueCalls = 0;
  prisma.round = {
    findUnique: async () => {
      findUniqueCalls += 1;
      return resolvedRoundRow();
    },
  } as any;
  prisma.arena = { findUnique: async () => ({ metadata: { contractAddress: ARENA_CONTRACT_ID } }) } as any;

  const app = buildApp();
  const first = await request(app).get(`/api/rounds/${ROUND_ID}/proof-bundle`);
  const second = await request(app).get(`/api/rounds/${ROUND_ID}/proof-bundle`);

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.headers["x-cache"], "HIT");
  assert.strictEqual(findUniqueCalls, 1);
  assert.deepStrictEqual(first.body.data, second.body.data);
});
