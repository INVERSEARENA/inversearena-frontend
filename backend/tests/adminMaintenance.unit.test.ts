import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { AdminController } from "../src/controllers/admin.controller";

type LoggedEntry = Record<string, unknown>;

function buildApp() {
  const logged: LoggedEntry[] = [];
  const consumedTokens: Array<{ token: string; action: string; resourceId: string }> = [];

  const adminService = {
    log: async (entry: LoggedEntry) => {
      logged.push(entry);
    },
    verifyAndConsumeToken: async (token: string, action: string, resourceId: string) => {
      consumedTokens.push({ token, action, resourceId });
    },
  } as any;

  const maintenanceService = {
    schedule: async (input: Record<string, unknown>) => ({
      id: "win-1",
      status: "scheduled",
      ...input,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
    }),
    cancel: async (id: string, cancelledBy: string) => ({
      id,
      status: "cancelled",
      cancelledBy,
      startLedgerSequence: 100,
      endLedgerSequence: 200,
      reason: "upgrade",
      scheduledBy: "admin-1",
      cancelledAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }),
    list: async () => [],
  } as any;

  const controller = new AdminController(adminService, {} as any, {} as any, maintenanceService);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.adminId = "admin-1";
    next();
  });
  app.post("/maintenance", (req, res, next) => {
    controller.scheduleMaintenance(req as any, res as any).catch(next);
  });
  app.delete("/maintenance/:id", (req, res, next) => {
    controller.cancelMaintenance(req as any, res as any).catch(next);
  });
  app.get("/maintenance", (req, res, next) => {
    controller.listMaintenanceWindows(req as any, res as any).catch(next);
  });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });

  return { app, logged, consumedTokens };
}

test("scheduleMaintenance: consumes the confirmation token scoped to the global resource", async () => {
  const { app, consumedTokens } = buildApp();

  const res = await request(app)
    .post("/maintenance")
    .send({ token: "tok-1", startLedgerSequence: 500, endLedgerSequence: 600, reason: "upgrade" });

  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(consumedTokens, [
    { token: "tok-1", action: "schedule_maintenance", resourceId: "global" },
  ]);
});

test("scheduleMaintenance: writes a success audit log entry", async () => {
  const { app, logged } = buildApp();

  await request(app)
    .post("/maintenance")
    .send({ token: "tok-1", startLedgerSequence: 500, endLedgerSequence: 600, reason: "upgrade" });

  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0]!.action, "schedule_maintenance");
  assert.strictEqual(logged[0]!.status, "success");
});

test("scheduleMaintenance: rejects a malformed body before touching the confirmation token", async () => {
  const { app, consumedTokens } = buildApp();

  const res = await request(app).post("/maintenance").send({ token: "tok-1" });

  assert.strictEqual(res.status, 500); // ZodError falls through to the generic handler in this test app
  assert.deepStrictEqual(consumedTokens, []);
});

test("cancelMaintenance: consumes the confirmation token scoped to the window id", async () => {
  const { app, consumedTokens } = buildApp();

  const res = await request(app).delete("/maintenance/win-1").send({ token: "tok-2" });

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(consumedTokens, [
    { token: "tok-2", action: "cancel_maintenance", resourceId: "win-1" },
  ]);
});

test("cancelMaintenance: logs failure and rethrows when the service rejects the cancel", async () => {
  const logged: LoggedEntry[] = [];
  const adminService = {
    log: async (entry: LoggedEntry) => {
      logged.push(entry);
    },
    verifyAndConsumeToken: async () => {},
  } as any;
  const maintenanceService = {
    cancel: async () => {
      throw Object.assign(new Error("Maintenance window is already completed"), { status: 409 });
    },
  } as any;
  const controller = new AdminController(adminService, {} as any, {} as any, maintenanceService);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.adminId = "admin-1";
    next();
  });
  app.delete("/maintenance/:id", (req, res, next) => {
    controller.cancelMaintenance(req as any, res as any).catch(next);
  });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });

  const res = await request(app).delete("/maintenance/win-1").send({ token: "tok-2" });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(logged[0]!.status, "failed");
});

test("listMaintenanceWindows: read-only, does not touch the confirmation token", async () => {
  const { app, consumedTokens } = buildApp();

  const res = await request(app).get("/maintenance");

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.windows, []);
  assert.deepStrictEqual(consumedTokens, []);
});
