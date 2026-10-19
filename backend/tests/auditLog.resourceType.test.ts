/**
 * Regression coverage for #1215: `deriveResourceType` must correctly extract
 * the resource segment from `req.path` when `auditLogMiddleware()` runs
 * inside the `/api/admin`-mounted sub-router, where Express's `req.path` is
 * already relative to the mount point (e.g. "/pools/pool-1/reindex", not
 * "/api/admin/pools/pool-1/reindex"). A naive `path.replace(/^\/admin\//, "")`
 * would never match here, silently producing `resourceType: ""` on every
 * single admin audit log entry ever written.
 */
import { describe, expect, it, afterEach } from "@jest/globals";
import express, { type Request, type Response } from "express";
import request from "supertest";

import { createAdminRouter } from "../src/routes/admin";
import { errorHandler } from "../src/middleware/errorHandler";
import { ApiKeyAuthProvider, requireAdmin } from "../src/middleware/auth";
import { deriveResourceType } from "../src/middleware/auditLog";
import { AuditLogModel } from "../src/db/models/auditLog.model";
import type { AdminController } from "../src/controllers/admin.controller";
import type { RoundController } from "../src/controllers/round.controller";

const ADMIN_API_KEY = "audit-log-unit-test-admin-api-key-0123456789";

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

describe("auditLogMiddleware — resourceType derivation (#1215)", () => {
  afterEach(async () => {
    await AuditLogModel.deleteMany({});
    delete process.env.ADMIN_API_KEY;
  });

  it("derives a non-empty resourceType for an authenticated request under the /api/admin mount", async () => {
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    const app = buildApp();

    const response = await request(app)
      .post("/api/admin/pools/pool-1/reindex")
      .set("Authorization", `Bearer ${ADMIN_API_KEY}`);
    expect(response.status).toBe(200);

    const entries = await waitForAuditLogs(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.resourceType).toBe("pools");
    expect(entries[0]!.resourceType).not.toBe("");
  });

  it("derives a non-empty resourceType for a failed-auth entry under the /api/admin mount", async () => {
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    const app = buildApp();

    const response = await request(app).post("/api/admin/reconciliation/run").send({});
    expect(response.status).toBe(401);

    const entries = await waitForAuditLogs(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.resourceType).toBe("reconciliation");
    expect(entries[0]!.resourceType).not.toBe("");
  });

  it("derives resourceType from the first meaningful segment regardless of nested path depth", async () => {
    process.env.ADMIN_API_KEY = ADMIN_API_KEY;
    const app = buildApp();

    const response = await request(app)
      .post("/api/admin/transactions/tx-42/force-resolve")
      .set("Authorization", `Bearer ${ADMIN_API_KEY}`);
    expect(response.status).toBe(200);

    const entries = await waitForAuditLogs(1);
    expect(entries[0]!.resourceType).toBe("transactions");
  });

});

describe("deriveResourceType (#1215)", () => {
  it("extracts the first segment from a router-relative path (the buggy case)", () => {
    // This is exactly the shape req.path has inside the /api/admin-mounted
    // sub-router: no "/admin/" prefix left to strip, since Express already
    // stripped the mount point. `path.replace(/^\/admin\//, "")` never
    // matches here, which was the root cause of #1215.
    expect(deriveResourceType("/pools/pool-1/reindex")).toBe("pools");
  });

  it("also handles the full mounted path, for callers that pass it unstripped", () => {
    expect(deriveResourceType("/api/admin/reconciliation/run")).toBe("reconciliation");
  });

  it("falls back to 'unknown' rather than an empty string when no segment is present", () => {
    expect(deriveResourceType("/")).toBe("unknown");
    expect(deriveResourceType("")).toBe("unknown");
    expect(deriveResourceType("/api/admin")).toBe("unknown");
  });
});
