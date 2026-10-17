/**
 * Arena watchlist routes — integration test (#1402), using
 * createWatchlistRouter directly (see routes/watchlist.ts's own comment
 * for why not the full users.ts router).
 */

const fakeUsers = new Map<string, { watchedArenaIds: string[] }>();

jest.mock("../src/db/models/user.model", () => ({
  UserModel: {
    findById: jest.fn((id: string) => {
      const doc = fakeUsers.get(id) ?? null;
      const result = doc ? { ...doc, _id: { toString: () => id } } : null;
      return { lean: () => Promise.resolve(result) };
    }),
    findByIdAndUpdate: jest.fn((id: string, update: Record<string, unknown>) => {
      const existing = fakeUsers.get(id);
      if (!existing) return { lean: () => Promise.resolve(null) };

      if (update.$addToSet && typeof update.$addToSet === "object") {
        const { watchedArenaIds: toAdd } = update.$addToSet as { watchedArenaIds: string };
        if (!existing.watchedArenaIds.includes(toAdd)) {
          existing.watchedArenaIds = [...existing.watchedArenaIds, toAdd];
        }
      }
      if (update.$pull && typeof update.$pull === "object") {
        const { watchedArenaIds: toRemove } = update.$pull as { watchedArenaIds: string };
        existing.watchedArenaIds = existing.watchedArenaIds.filter((id2) => id2 !== toRemove);
      }

      fakeUsers.set(id, existing);
      return { lean: () => Promise.resolve({ ...existing, _id: { toString: () => id } }) };
    }),
  },
}));

import { describe, expect, it, beforeEach } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

import { createWatchlistRouter } from "../src/routes/watchlist";
import { errorHandler } from "../src/middleware/errorHandler";
import type { PrismaClient } from "@prisma/client";

function makePrisma(existingArenaIds: string[]): PrismaClient {
  return {
    arena: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        existingArenaIds.includes(where.id) ? { id: where.id } : null,
      ),
    },
  } as unknown as PrismaClient;
}

function buildApp(prisma: PrismaClient) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const user = req.header("x-test-user");
    if (user) req.user = { id: user, walletAddress: "G", jti: "j" };
    next();
  });
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED" } });
      return;
    }
    next();
  };
  app.use("/api/users", createWatchlistRouter(prisma, authMiddleware));
  app.use(errorHandler);
  return app;
}

describe("arena watchlist routes", () => {
  beforeEach(() => {
    fakeUsers.clear();
  });

  it("requires authentication", async () => {
    const app = buildApp(makePrisma([]));
    const res = await request(app).get("/api/users/me/watchlist");
    expect(res.status).toBe(401);
  });

  it("lists the caller's watchlist", async () => {
    fakeUsers.set("user-1", { watchedArenaIds: ["arena-1"] });
    const app = buildApp(makePrisma(["arena-1"]));

    const res = await request(app).get("/api/users/me/watchlist").set("x-test-user", "user-1");

    expect(res.status).toBe(200);
    expect(res.body.watchedArenaIds).toEqual(["arena-1"]);
  });

  it("watches an arena", async () => {
    fakeUsers.set("user-1", { watchedArenaIds: [] });
    const app = buildApp(makePrisma(["arena-1"]));

    const res = await request(app).put("/api/users/me/watchlist/arena-1").set("x-test-user", "user-1");

    expect(res.status).toBe(200);
    expect(res.body.watchedArenaIds).toEqual(["arena-1"]);
  });

  it("watching twice is idempotent", async () => {
    fakeUsers.set("user-1", { watchedArenaIds: [] });
    const app = buildApp(makePrisma(["arena-1"]));

    await request(app).put("/api/users/me/watchlist/arena-1").set("x-test-user", "user-1");
    const second = await request(app).put("/api/users/me/watchlist/arena-1").set("x-test-user", "user-1");

    expect(second.status).toBe(200);
    expect(second.body.watchedArenaIds).toEqual(["arena-1"]);
  });

  it("returns 404 for watching a nonexistent arena", async () => {
    fakeUsers.set("user-1", { watchedArenaIds: [] });
    const app = buildApp(makePrisma([]));

    const res = await request(app).put("/api/users/me/watchlist/missing-arena").set("x-test-user", "user-1");
    expect(res.status).toBe(404);
  });

  it("unwatches an arena", async () => {
    fakeUsers.set("user-1", { watchedArenaIds: ["arena-1"] });
    const app = buildApp(makePrisma(["arena-1"]));

    const res = await request(app).delete("/api/users/me/watchlist/arena-1").set("x-test-user", "user-1");

    expect(res.status).toBe(200);
    expect(res.body.watchedArenaIds).toEqual([]);
  });

  it("unwatching twice is idempotent", async () => {
    fakeUsers.set("user-1", { watchedArenaIds: ["arena-1"] });
    const app = buildApp(makePrisma(["arena-1"]));

    await request(app).delete("/api/users/me/watchlist/arena-1").set("x-test-user", "user-1");
    const second = await request(app).delete("/api/users/me/watchlist/arena-1").set("x-test-user", "user-1");

    expect(second.status).toBe(200);
    expect(second.body.watchedArenaIds).toEqual([]);
  });

  it("persists watching across independent requests (same user, simulating another device)", async () => {
    fakeUsers.set("user-1", { watchedArenaIds: [] });
    const prisma = makePrisma(["arena-1"]);
    const app = buildApp(prisma);

    await request(app).put("/api/users/me/watchlist/arena-1").set("x-test-user", "user-1");

    // A second, independent request (as if from a different device/session)
    // sees the same persisted state.
    const res = await request(app).get("/api/users/me/watchlist").set("x-test-user", "user-1");
    expect(res.body.watchedArenaIds).toEqual(["arena-1"]);
  });
});
