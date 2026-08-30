import express from "express";
import request from "supertest";
import { prisma } from "../src/db/prisma";
import { errorHandler } from "../src/middleware/errorHandler";
import { clearLimiterCache } from "../src/middleware/rateLimit";
import { createPoolsRouter } from "../src/routes/pools";

const ARENA_ID = `C${"A".repeat(55)}`;
const originalArena = prisma.arena;
const originalPool = prisma.pool;

describe("POST /api/pools (#1224)", () => {
  afterEach(() => {
    prisma.arena = originalArena;
    prisma.pool = originalPool;
    clearLimiterCache();
  });

  it("returns ARENA_NOT_FOUND without attempting an insert", async () => {
    const create = jest.fn();
    prisma.arena = { findUnique: jest.fn(async () => null) } as never;
    prisma.pool = { create } as never;

    const app = express();
    app.use(express.json());
    app.use("/api/pools", createPoolsRouter((_req, _res, next) => next()));
    app.use(errorHandler);

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
    prisma.arena = { findUnique: jest.fn(async () => ({ id: ARENA_ID })) } as never;
    prisma.pool = { create: jest.fn(async () => pool) } as never;

    const app = express();
    app.use(express.json());
    app.use("/api/pools", createPoolsRouter((_req, _res, next) => next()));
    app.use(errorHandler);

    const response = await request(app)
      .post("/api/pools")
      .send({ arenaId: ARENA_ID, stakeAmount: 25 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(pool);
    expect(prisma.pool.create).toHaveBeenCalledWith({
      data: { arenaId: ARENA_ID, stakeAmount: 25 },
    });
  });
});
