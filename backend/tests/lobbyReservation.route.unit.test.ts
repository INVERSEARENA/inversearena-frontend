/**
 * Route coverage for backend-authoritative lobby capacity reservations
 * (#1406): POST/DELETE /api/arenas/:id/reservation.
 */
import express from "express";
import request from "supertest";
import { errorHandler } from "../src/middleware/errorHandler";

const reserveSlot = jest.fn();
const releaseSlot = jest.fn();
jest.mock("../src/cache/lobbyReservationStore", () => ({
  lobbyReservationStore: {
    reserveSlot: (...args: unknown[]) => reserveSlot(...args),
    releaseSlot: (...args: unknown[]) => releaseSlot(...args),
  },
}));

const findUniqueArena = jest.fn();
jest.mock("../src/db/prisma", () => ({
  prisma: {
    arena: {
      findUnique: (...args: unknown[]) => findUniqueArena(...args),
    },
  },
}));

const getArenaStats = jest.fn();
jest.mock("../src/services/arenaStatsService", () => ({
  ArenaStatsService: jest.fn().mockImplementation(() => ({
    getArenaStats: (...args: unknown[]) => getArenaStats(...args),
  })),
}));

// The rate limiter talks to Redis; bypass it entirely for these route tests
// (rate limiting itself is covered by rateLimit's own unit tests).
jest.mock("../src/middleware/rateLimit", () => ({
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getLobbyReservationRateLimitConfig: () => ({
    keyPrefix: "rl:test",
    points: 10,
    durationSeconds: 60,
  }),
}));

import { createLobbyReservationRouter } from "../src/routes/lobbyReservation";

function buildApp(userId: string | null) {
  const app = express();
  app.use(express.json());
  const authMiddleware = (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    if (userId) {
      req.user = { id: userId, walletAddress: "GUSER", jti: "jti-1" };
    }
    next();
  };
  app.use("/api/arenas", createLobbyReservationRouter(authMiddleware));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  reserveSlot.mockReset();
  releaseSlot.mockReset();
  findUniqueArena.mockReset();
  getArenaStats.mockReset();
});

describe("POST /api/arenas/:id/reservation", () => {
  it("requires authentication", async () => {
    const app = buildApp(null);

    const response = await request(app).post("/api/arenas/arena-1/reservation");

    expect(response.status).toBe(401);
    expect(reserveSlot).not.toHaveBeenCalled();
  });

  it("returns 404 when the arena does not exist", async () => {
    findUniqueArena.mockResolvedValue(null);
    const app = buildApp("user-1");

    const response = await request(app).post("/api/arenas/missing/reservation");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ARENA_NOT_FOUND");
  });

  it("reserves a slot and returns its expiry when capacity remains", async () => {
    findUniqueArena.mockResolvedValue({ id: "arena-1" });
    getArenaStats.mockResolvedValue({ maxPlayers: 10, playerCount: 4 });
    reserveSlot.mockResolvedValue({
      reserved: true,
      expiresAt: "2026-01-01T00:02:00.000Z",
    });
    const app = buildApp("user-1");

    const response = await request(app).post("/api/arenas/arena-1/reservation");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      arenaId: "arena-1",
      expiresAt: "2026-01-01T00:02:00.000Z",
    });
    // remainingCapacity handed to the store must be maxPlayers - playerCount,
    // not maxPlayers alone — confirmed players consume capacity outright.
    expect(reserveSlot).toHaveBeenCalledWith("arena-1", "user-1", 6, expect.any(Number));
  });

  it("returns 409 when the store reports the arena is full", async () => {
    findUniqueArena.mockResolvedValue({ id: "arena-1" });
    getArenaStats.mockResolvedValue({ maxPlayers: 10, playerCount: 10 });
    reserveSlot.mockResolvedValue({ reserved: false, expiresAt: null });
    const app = buildApp("user-1");

    const response = await request(app).post("/api/arenas/arena-1/reservation");

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ARENA_FULL");
  });

  it("returns 409 without calling the store when the arena has no configured capacity", async () => {
    findUniqueArena.mockResolvedValue({ id: "arena-1" });
    getArenaStats.mockResolvedValue({ maxPlayers: 0, playerCount: 0 });
    const app = buildApp("user-1");

    const response = await request(app).post("/api/arenas/arena-1/reservation");

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ARENA_CAPACITY_UNKNOWN");
    expect(reserveSlot).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/arenas/:id/reservation", () => {
  it("requires authentication", async () => {
    const app = buildApp(null);

    const response = await request(app).delete("/api/arenas/arena-1/reservation");

    expect(response.status).toBe(401);
    expect(releaseSlot).not.toHaveBeenCalled();
  });

  it("releases the caller's reservation and returns 204", async () => {
    releaseSlot.mockResolvedValue(undefined);
    const app = buildApp("user-1");

    const response = await request(app).delete("/api/arenas/arena-1/reservation");

    expect(response.status).toBe(204);
    expect(releaseSlot).toHaveBeenCalledWith("arena-1", "user-1");
  });
});
