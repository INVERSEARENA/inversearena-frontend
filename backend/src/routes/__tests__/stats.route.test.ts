import express from "express";
import request from "supertest";

import { createStatsRouter } from "../stats";
import { errorHandler } from "../../middleware/errorHandler";
import type { LandingStatsService } from "../../services/landingStatsService";

function appWith(service: LandingStatsService): express.Express {
  const app = express();
  app.use("/api/stats", createStatsRouter(service));
  app.use(errorHandler);
  return app;
}

const statsService = {
  getLandingStats: jest.fn(async () => ({
    totalArenas: 10,
    activeArenas: 3,
    totalPlayers: 99,
    totalYieldAccrued: 42,
    generatedAt: "2026-05-01T00:00:00.000Z",
  })),
} as unknown as LandingStatsService;

describe("GET /api/stats/landing (#1626)", () => {
  it("returns the landing stats payload", async () => {
    const res = await request(appWith(statsService)).get("/api/stats/landing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalArenas: 10,
      activeArenas: 3,
      totalPlayers: 99,
      totalYieldAccrued: 42,
      generatedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("emits a shared cache directive with stale-while-revalidate", async () => {
    const res = await request(appWith(statsService)).get("/api/stats/landing");

    expect(res.headers["cache-control"]).toMatch(/^public, max-age=\d+, must-revalidate, stale-while-revalidate=\d+/);
  });

  it("omits the shared directive for an authenticated request", async () => {
    const res = await request(appWith(statsService))
      .get("/api/stats/landing")
      .set("Authorization", "Bearer token");

    expect(res.headers["cache-control"]).toBeUndefined();
  });
});
