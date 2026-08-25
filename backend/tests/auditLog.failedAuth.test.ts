/**
 * Regression coverage for #1216: failed admin-authentication attempts must
 * still be audited. Previously `writeAuditLog` bailed out entirely whenever
 * `req.adminId` was unset — exactly the case for a request that fails
 * `requireAdmin` (bad/missing API key) — leaving zero trail for repeated
 * unauthorized attempts against destructive admin routes.
 */
import { describe, expect, it, afterEach } from "@jest/globals";
import express, { type Request, type Response } from "express";
import request from "supertest";

import { createAdminRouter } from "../src/routes/admin";
import { errorHandler } from "../src/middleware/errorHandler";
import { ApiKeyAuthProvider, requireAdmin } from "../src/middleware/auth";
import { AuditLogModel } from "../src/db/models/auditLog.model";
import type { AdminController } from "../src/controllers/admin.controller";
import type { RoundController } from "../src/controllers/round.controller";

const ADMIN_API_KEY = "audit-log-unit-test-admin-api-key-0123456789";

/**
 * auditLogMiddleware writes the audit entry fire-and-forget (it explicitly
 * does not block the response — see the middleware's own comment), so the
 * write can still be in flight immediately after supertest's request
 * resolves. Poll briefly instead of asserting on a single synchronous read.
 */
async function waitForAuditLogs(expectedCount: number, timeoutMs = 2000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const entries = await AuditLogModel.find({}).lean();
    if (entries.length >= expectedCount || Date.now() - start > timeoutMs) {
      return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function buildApp() {
  const adminController = {
    requestToken: async (_req: Request, res: Response) => res.json({ ok: true }),
    forceResolveTransaction: async (_req: Request, res: Response) => res.json({ ok: true }),
    resubmitTransaction: async (_req: Request, res: Response) => res.json({ ok: true }),
    reindexPool: async (_req: Request, res: Response) => res.json({ ok: true }),
    runReconciliation: async (_req: Request, res: Response) => res.json({ ok: true }),
    listAuditLogs: async (_req: Request, res: Response) => res.json({ logs: [], total: 0 }),
  } as unknown as AdminController;

  const roundController = {
    closeRound: async (_req: Request, res: Response) => res.json({ ok: true }),
    resolveRound: async (_req: Request, res: Response) => res.json({ ok: true }),
  } as unknown as RoundController;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin",
    createAdminRouter(adminController, roundController, requireAdmin(new ApiKeyAuthProvider())),
  );
  app.use(errorHandler);
  return app;
}

describe("auditLogMiddleware — failed admin authentication (#1216)", () => {
  afterEach(async () => {
    await AuditLogModel.deleteMany({});
    delete process.env.ADMIN_API_KEY;
  });

  it("writes an audit_failed entry, keyed by IP, when the API key is missing", async () => {
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    const app = buildApp();

    const response = await request(app).post("/api/admin/reconciliation/run").send({});
    expect(response.status).toBe(401);

    const entries = await waitForAuditLogs(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "auth_failed",
      action: expect.stringContaining("/reconciliation/run"),
    });
    expect(entries[0]!.adminId).toMatch(/^unauthenticated:/);
  });

  it("writes an audit_failed entry when the API key is wrong", async () => {
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    const app = buildApp();

    const response = await request(app)
      .post("/api/admin/pools/pool-1/reindex")
      .set("Authorization", "Bearer totally-wrong-key-same-length-000000")
      .send({});
    expect(response.status).toBe(401);

    const entries = await waitForAuditLogs(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("auth_failed");
  });

  it("still writes a normal success entry for an authenticated admin request", async () => {
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    const app = buildApp();

    const response = await request(app)
      .get("/api/admin/audit-logs")
      .set("Authorization", `Bearer ${ADMIN_API_KEY}`);
    expect(response.status).toBe(200);

    const entries = await waitForAuditLogs(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("success");
    expect(entries[0]!.adminId).not.toMatch(/^unauthenticated:/);
  });

  it("does not double-count repeated unauthorized attempts into one entry", async () => {
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    const app = buildApp();

    await request(app).post("/api/admin/reconciliation/run").send({});
    await request(app).post("/api/admin/reconciliation/run").send({});
    await request(app).post("/api/admin/reconciliation/run").send({});

    const entries = await waitForAuditLogs(3);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.status === "auth_failed")).toBe(true);
  });
});
