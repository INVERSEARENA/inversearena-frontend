import express from "express";
import request from "supertest";
import { prisma } from "../src/db/prisma";
import { errorHandler } from "../src/middleware/errorHandler";
import { clearLimiterCache } from "../src/middleware/rateLimit";
import { createPoolsRouter } from "../src/routes/pools";

const releaseSlot = jest.fn();
jest.mock("../src/cache/lobbyReservationStore", () => ({
  lobbyReservationStore: {
    releaseSlot: (...args: unknown[]) => releaseSlot(...args),
  },
}));

const ARENA_ID = `C${"A".repeat(55)}`;
const originalArena = prisma.arena;
const originalPool = prisma.pool;

function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/pools",
    createPoolsRouter((req, _res, next) => {
      if (userId) req.user = { id: userId, walletAddress: "GUSER", jti: "jti-1" };
      next();
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /api/pools (#1224)", () => {
  afterEach(() => {
    (prisma as any).arena = originalArena;
    (prisma as any).pool = originalPool;
    clearLimiterCache();
    releaseSlot.mockReset();
  });

  it("returns ARENA_NOT_FOUND without attempting an insert", async () => {
    const create = jest.fn();
    (prisma as any).arena = { findUnique: jest.fn(async () => null) };
    (prisma as any).pool = { create };

    const app = buildApp();

    const response = await request(app)
      .post("/api/pools")
      .send({ arenaId: ARENA_ID, stakeAmount: 25 });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "ARENA_NOT_FOUND",
        message: `Arena with ID ${ARENA_ID} not found`,
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a pool after confirming the arena exists", async () => {
    const pool = { id: "pool-1", arenaId: ARENA_ID, stakeAmount: 25 };
    (prisma as any).arena = { findUnique: jest.fn(async () => ({ id: ARENA_ID })) };
    (prisma as any).pool = { create: jest.fn(async () => pool) };

    const app = buildApp();

    const response = await request(app)
      .post("/api/pools")
      .send({ arenaId: ARENA_ID, stakeAmount: 25 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(pool);
    expect(prisma.pool.create).toHaveBeenCalledWith({
      data: { arenaId: ARENA_ID, stakeAmount: 25 },
    });
  });

  describe("lobby reservation release on confirmed join (#1406)", () => {
    it("releases the authenticated user's reservation after the pool is created", async () => {
      const pool = { id: "pool-1", arenaId: ARENA_ID, stakeAmount: 25 };
      (prisma as any).arena = { findUnique: jest.fn(async () => ({ id: ARENA_ID })) };
      (prisma as any).pool = { create: jest.fn(async () => pool) };
      releaseSlot.mockResolvedValue(undefined);

      const app = buildApp("user-1");

      const response = await request(app)
        .post("/api/pools")
        .send({ arenaId: ARENA_ID, stakeAmount: 25 });

      expect(response.status).toBe(201);
      expect(releaseSlot).toHaveBeenCalledWith(ARENA_ID, "user-1");
    });

    it("does not attempt a release when the request is unauthenticated", async () => {
      const pool = { id: "pool-1", arenaId: ARENA_ID, stakeAmount: 25 };
      (prisma as any).arena = { findUnique: jest.fn(async () => ({ id: ARENA_ID })) };
      (prisma as any).pool = { create: jest.fn(async () => pool) };

      const app = buildApp();

      const response = await request(app)
        .post("/api/pools")
        .send({ arenaId: ARENA_ID, stakeAmount: 25 });

      expect(response.status).toBe(201);
      expect(releaseSlot).not.toHaveBeenCalled();
    });

    it("still returns 201 when releasing the reservation fails", async () => {
      const pool = { id: "pool-1", arenaId: ARENA_ID, stakeAmount: 25 };
      (prisma as any).arena = { findUnique: jest.fn(async () => ({ id: ARENA_ID })) };
      (prisma as any).pool = { create: jest.fn(async () => pool) };
      releaseSlot.mockRejectedValue(new Error("redis unavailable"));

      const app = buildApp("user-1");

      const response = await request(app)
        .post("/api/pools")
        .send({ arenaId: ARENA_ID, stakeAmount: 25 });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(pool);
    });
  });
});
