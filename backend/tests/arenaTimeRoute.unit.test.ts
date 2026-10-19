/**
 * GET /api/arenas/time (#1401) — signed server-time endpoint. Route-level
 * smoke test using arenaTimeRouter directly (not the full arenas.ts
 * router, which has a pre-existing broken cross-boundary import unrelated
 * to this change — see routes/arenaTime.ts's own comment). serverTimeService's
 * own signing/verification behavior is covered by serverTimeService.unit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";

import { arenaTimeRouter } from "../src/routes/arenaTime";
import { errorHandler } from "../src/middleware/errorHandler";
import { verifySignedServerTime } from "../src/services/serverTimeService";

const CURRENT = "a".repeat(32);

function buildApp() {
  const app = express();
  app.use("/api/arenas", arenaTimeRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /api/arenas/time", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("JWT_SECRET")) delete process.env[key];
    process.env.JWT_SECRET = CURRENT;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("JWT_SECRET")) delete process.env[key];
  });

  it("returns the current server time and a verifiable signed token", async () => {
    const before = Date.now();
    const res = await request(buildApp()).get("/api/arenas/time");
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.serverTimeMs).toBeGreaterThanOrEqual(before);
    expect(res.body.serverTimeMs).toBeLessThanOrEqual(after);

    const verification = verifySignedServerTime(res.body.token);
    expect(verification).toEqual({ ok: true, serverTimeMs: res.body.serverTimeMs });
  });

  it("does not require authentication", async () => {
    const res = await request(buildApp()).get("/api/arenas/time");
    expect(res.status).toBe(200);
  });

  it("returns a fresh serverTimeMs on each request", async () => {
    const app = buildApp();
    const first = await request(app).get("/api/arenas/time");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await request(app).get("/api/arenas/time");

    expect(second.body.serverTimeMs).toBeGreaterThanOrEqual(first.body.serverTimeMs);
  });
});
