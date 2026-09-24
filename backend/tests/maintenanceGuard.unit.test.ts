import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { maintenanceGuard } from "../src/middleware/maintenance";
import type { MaintenanceService } from "../src/services/maintenanceService";

function buildApp(service: Pick<MaintenanceService, "getStatus">) {
  const app = express();
  app.use(express.json());
  app.use(maintenanceGuard(service as MaintenanceService));

  app.get("/api/arenas/1", (_req, res) => res.json({ ok: true }));
  app.post("/api/arenas/1/join", (_req, res) => res.json({ ok: true }));
  app.post("/api/admin/rounds/resolve", (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/verify", (_req, res) => res.json({ ok: true }));

  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });

  return app;
}

const inactive = { getStatus: async () => ({ active: false, currentLedgerSequence: 1, window: null }) };
const active = {
  getStatus: async () => ({
    active: true,
    currentLedgerSequence: 500,
    window: {
      id: "win-1",
      scheduledBy: "admin-1",
      startLedgerSequence: 400,
      endLedgerSequence: 700,
      reason: "upgrade",
      status: "active" as const,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
    },
  }),
};

test("maintenanceGuard: GET requests always pass through, active window or not", async () => {
  const app = buildApp(active);
  const res = await request(app).get("/api/arenas/1");
  assert.strictEqual(res.status, 200);
});

test("maintenanceGuard: mutating requests pass through when no window is active", async () => {
  const app = buildApp(inactive);
  const res = await request(app).post("/api/arenas/1/join").send({});
  assert.strictEqual(res.status, 200);
});

test("maintenanceGuard: mutating requests are blocked with 503 when a window is active", async () => {
  const app = buildApp(active);
  const res = await request(app).post("/api/arenas/1/join").send({});
  assert.strictEqual(res.status, 503);
  assert.match(res.body.error, /ledger 700/);
});

test("maintenanceGuard: admin mutations stay reachable during an active window", async () => {
  const app = buildApp(active);
  const res = await request(app).post("/api/admin/rounds/resolve").send({});
  assert.strictEqual(res.status, 200);
});

test("maintenanceGuard: auth mutations stay reachable during an active window", async () => {
  const app = buildApp(active);
  const res = await request(app).post("/api/auth/verify").send({});
  assert.strictEqual(res.status, 200);
});

test("maintenanceGuard: a ledger-clock failure fails closed (503), not open", async () => {
  const failing = {
    getStatus: async () => {
      throw Object.assign(new Error("Soroban RPC circuit is OPEN"), { status: 503 });
    },
  };
  const app = buildApp(failing);
  const res = await request(app).post("/api/arenas/1/join").send({});
  assert.strictEqual(res.status, 503);
});
