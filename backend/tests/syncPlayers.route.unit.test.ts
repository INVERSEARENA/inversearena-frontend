/**
 * Regression coverage for #1218: POST /api/arenas/:id/sync-players used to
 * run `for (const walletAddress of onChainPlayers) { await
 * prisma.user.upsert(...) }` — one DB round trip per on-chain player,
 * serially awaited. It now batches with a single
 * `prisma.user.createMany({ skipDuplicates: true })` call.
 */
import { jest } from "@jest/globals";

jest.mock("../src/services/onChainReader", () => ({
  getOnChainPlayers: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { createArenasRouter } from "../src/routes/arenas";
import { errorHandler } from "../src/middleware/errorHandler";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/cache/redisClient";
import { getOnChainPlayers } from "../src/services/onChainReader";

const mockGetOnChainPlayers = getOnChainPlayers as jest.MockedFunction<typeof getOnChainPlayers>;
const authMiddleware = (_req: any, _res: any, next: any) => next();

const originalArena = prisma.arena;
const originalUser = prisma.user;

afterEach(() => {
  (prisma as any).arena = originalArena;
  (prisma as any).user = originalUser;
  jest.clearAllMocks();
});

afterAll(() => {
  redis.disconnect();
});

describe("POST /api/arenas/:id/sync-players (#1218)", () => {
  it("batches all on-chain players into a single createMany call instead of N sequential upserts", async () => {
    (prisma as any).arena = {
      findUnique: async () => ({ id: "arena-1", metadata: { contractAddress: "C123" } }),
    } as any;

    let createManyCalls = 0;
    let capturedData: unknown;
    let upsertCalls = 0;
    (prisma as any).user = {
      createMany: async (args: any) => {
        createManyCalls++;
        capturedData = args.data;
        expect(args.skipDuplicates).toBe(true);
        return { count: args.data.length };
      },
      // Fails the test if the old per-player upsert path is still used.
      upsert: async () => {
        upsertCalls++;
        return {};
      },
    } as any;

    mockGetOnChainPlayers.mockResolvedValue(["GPLAYER1", "GPLAYER2", "GPLAYER3"]);

    const app = express();
    app.use("/api/arenas", createArenasRouter(authMiddleware));
    app.use(errorHandler);

    const response = await request(app).post("/api/arenas/arena-1/sync-players").send({});

    expect(response.status).toBe(200);
    expect(createManyCalls).toBe(1); // one round trip, not N
    expect(upsertCalls).toBe(0);
    expect(capturedData).toEqual([
      { walletAddress: "GPLAYER1" },
      { walletAddress: "GPLAYER2" },
      { walletAddress: "GPLAYER3" },
    ]);
    expect(response.body.totalPlayers).toBe(3);
    expect(response.body.syncedPlayers).toBe(3);
  });

  it("handles an empty on-chain player list without erroring", async () => {
    (prisma as any).arena = {
      findUnique: async () => ({ id: "arena-1", metadata: { contractAddress: "C123" } }),
    } as any;

    let createManyCalls = 0;
    (prisma as any).user = {
      createMany: async (args: any) => {
        createManyCalls++;
        expect(args.data).toEqual([]);
        return { count: 0 };
      },
    } as any;

    mockGetOnChainPlayers.mockResolvedValue([]);

    const app = express();
    app.use("/api/arenas", createArenasRouter(authMiddleware));
    app.use(errorHandler);

    const response = await request(app).post("/api/arenas/arena-1/sync-players").send({});

    expect(response.status).toBe(200);
    expect(createManyCalls).toBe(1);
    expect(response.body.totalPlayers).toBe(0);
    expect(response.body.syncedPlayers).toBe(0);
  });

  it("skips existing wallet addresses without erroring (skipDuplicates semantics)", async () => {
    (prisma as any).arena = {
      findUnique: async () => ({ id: "arena-1", metadata: { contractAddress: "C123" } }),
    } as any;

    (prisma as any).user = {
      // Simulate 2 of the 3 wallets already existing — createMany with
      // skipDuplicates reports only the newly inserted count.
      createMany: async (args: any) => ({ count: 1 }),
    } as any;

    mockGetOnChainPlayers.mockResolvedValue(["GEXISTING1", "GEXISTING2", "GNEW1"]);

    const app = express();
    app.use("/api/arenas", createArenasRouter(authMiddleware));
    app.use(errorHandler);

    const response = await request(app).post("/api/arenas/arena-1/sync-players").send({});

    expect(response.status).toBe(200);
    // Response mirrors totalPlayers (matches pre-existing per-player-loop
    // behavior, which always "synced" every on-chain player regardless of
    // new-vs-existing), independent of createMany's newly-inserted count.
    expect(response.body.totalPlayers).toBe(3);
    expect(response.body.syncedPlayers).toBe(3);
  });

  it("returns 400 when the arena has no contract address", async () => {
    (prisma as any).arena = {
      findUnique: async () => ({ id: "arena-1", metadata: {} }),
    } as any;

    const app = express();
    app.use("/api/arenas", createArenasRouter(authMiddleware));
    app.use(errorHandler);

    const response = await request(app).post("/api/arenas/arena-1/sync-players").send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("NO_CONTRACT_ADDRESS");
  });

  it("returns 404 when the arena does not exist", async () => {
    (prisma as any).arena = {
      findUnique: async () => null,
    } as any;

    const app = express();
    app.use("/api/arenas", createArenasRouter(authMiddleware));
    app.use(errorHandler);

    const response = await request(app).post("/api/arenas/missing-arena/sync-players").send({});

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ARENA_NOT_FOUND");
  });
});
