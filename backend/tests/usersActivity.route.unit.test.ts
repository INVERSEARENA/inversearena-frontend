/**
 * Route coverage for GET /api/users/me/activity (#1403): auth, query
 * validation, and correct wiring of walletAddress into the activity
 * service (not req.user.id — see users.controller.ts's activity handler
 * doc comment for why).
 */
import express from "express";
import request from "supertest";
import { errorHandler } from "../src/middleware/errorHandler";

const getActivityFeed = jest.fn();
jest.mock("../src/services/playerActivityService", () => ({
  PlayerActivityService: jest.fn().mockImplementation(() => ({
    getActivityFeed: (...args: unknown[]) => getActivityFeed(...args),
  })),
}));

jest.mock("../src/db/models/user.model", () => ({
  UserModel: { findById: jest.fn() },
}));

import { UsersController } from "../src/controllers/users.controller";
import { createUsersRouter } from "../src/routes/users";

function buildApp(user?: { id: string; walletAddress: string }) {
  const app = express();
  const controller = new UsersController({} as any);
  // Mirrors production's requireAuth (src/middleware/auth.ts): reject with
  // 401 before next() when there's no valid session, rather than calling
  // next() and leaving req.user undefined for the handler to trip over.
  const authMiddleware = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }
    req.user = { ...user, jti: "jti-1" };
    next();
  };
  app.use("/api/users", createUsersRouter(controller, authMiddleware));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  getActivityFeed.mockReset();
});

describe("GET /api/users/me/activity", () => {
  it("requires authentication", async () => {
    const app = buildApp();

    const response = await request(app).get("/api/users/me/activity");

    expect(response.status).toBe(401);
    expect(getActivityFeed).not.toHaveBeenCalled();
  });

  it("queries the activity service by walletAddress, not the Mongo user id", async () => {
    getActivityFeed.mockResolvedValue({
      walletAddress: "GWALLET",
      items: [],
      cursor: null,
      hasMore: false,
    });
    const app = buildApp({ id: "mongo-id-123", walletAddress: "GWALLET" });

    await request(app).get("/api/users/me/activity");

    expect(getActivityFeed).toHaveBeenCalledWith("GWALLET", 25, undefined);
  });

  it("passes through limit and cursor query params", async () => {
    getActivityFeed.mockResolvedValue({
      walletAddress: "GWALLET",
      items: [],
      cursor: null,
      hasMore: false,
    });
    const app = buildApp({ id: "mongo-id-123", walletAddress: "GWALLET" });

    await request(app)
      .get("/api/users/me/activity")
      .query({ limit: "10", cursor: "abc123" });

    expect(getActivityFeed).toHaveBeenCalledWith("GWALLET", 10, "abc123");
  });

  it("rejects a limit above the maximum", async () => {
    const app = buildApp({ id: "mongo-id-123", walletAddress: "GWALLET" });

    const response = await request(app)
      .get("/api/users/me/activity")
      .query({ limit: "1000" });

    expect(response.status).toBe(400);
    expect(getActivityFeed).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric limit", async () => {
    const app = buildApp({ id: "mongo-id-123", walletAddress: "GWALLET" });

    const response = await request(app)
      .get("/api/users/me/activity")
      .query({ limit: "not-a-number" });

    expect(response.status).toBe(400);
    expect(getActivityFeed).not.toHaveBeenCalled();
  });

  it("defaults limit to 25 when omitted", async () => {
    getActivityFeed.mockResolvedValue({
      walletAddress: "GWALLET",
      items: [],
      cursor: null,
      hasMore: false,
    });
    const app = buildApp({ id: "mongo-id-123", walletAddress: "GWALLET" });

    await request(app).get("/api/users/me/activity");

    expect(getActivityFeed).toHaveBeenCalledWith("GWALLET", 25, undefined);
  });

  it("returns the service's page shape as-is", async () => {
    const page = {
      walletAddress: "GWALLET",
      items: [
        {
          id: "elim-1",
          type: "player_eliminated",
          timestamp: "2026-01-01T00:00:00.000Z",
          arenaId: "arena-1",
          roundNumber: 3,
          reason: "ELIMINATED_BY_ROUND",
        },
      ],
      cursor: "next-cursor",
      hasMore: true,
    };
    getActivityFeed.mockResolvedValue(page);
    const app = buildApp({ id: "mongo-id-123", walletAddress: "GWALLET" });

    const response = await request(app).get("/api/users/me/activity");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
  });

  it("propagates a service failure as a 500 without crashing the process", async () => {
    getActivityFeed.mockRejectedValue(new Error("db unavailable"));
    const app = buildApp({ id: "mongo-id-123", walletAddress: "GWALLET" });

    const response = await request(app).get("/api/users/me/activity");

    expect(response.status).toBe(500);
  });
});
