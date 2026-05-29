import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { createArenasRouter } from "../src/routes/arenas";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/cache/redisClient";

const authMiddleware = (_req: any, _res: any, next: any) => next();

const originalArena = prisma.arena;
const originalRound = prisma.round;

test.afterEach(() => {
  prisma.arena = originalArena;
  prisma.round = originalRound;
  redis.disconnect();
});

test("GET /api/arenas/:id/rounds returns 404 when arena does not exist", async () => {
  prisma.arena = {
    findUnique: async () => null,
  } as any;

  const app = express();
  app.use("/api/arenas", createArenasRouter(authMiddleware));

  const response = await request(app).get("/api/arenas/missing-arena/rounds");

  assert.strictEqual(response.status, 404);
  assert.deepStrictEqual(response.body, { error: { code: "ARENA_NOT_FOUND" } });
});

test("GET /api/arenas/:id/rounds returns paginated round history", async () => {
  prisma.arena = {
    findUnique: async () => ({ id: "arena-1" }),
  } as any;

  prisma.round = {
    findMany: async ({ where, take, skip }: any) => {
      assert.strictEqual(where.arenaId, "arena-1");
      assert.strictEqual(take, 3);
      assert.strictEqual(skip, 0);

      return [
        {
          id: "round-1",
          roundNumber: 1,
          state: "OPEN",
          metadata: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "round-2",
          roundNumber: 2,
          state: "RESOLVED",
          metadata: { resolution: { eliminatedPlayers: ["user1", "user2"], payouts: [], poolBalances: {} } },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "round-3",
          roundNumber: 3,
          state: "CLOSED",
          metadata: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ];
    },
  } as any;

  const app = express();
  app.use("/api/arenas", createArenasRouter(authMiddleware));

  const response = await request(app).get("/api/arenas/arena-1/rounds?limit=2");

  assert.strictEqual(response.status, 200);
  assert.strictEqual(Array.isArray(response.body.items), true);
  assert.strictEqual(response.body.items.length, 2);
  assert.strictEqual(response.body.items[0].roundNumber, 1);
  assert.strictEqual(response.body.items[1].state, "RESOLVED");
  assert.strictEqual(response.body.items[1].eliminationCount, 2);
  assert.strictEqual(response.body.hasMore, true);
  assert.strictEqual(typeof response.body.cursor, "string");
});
