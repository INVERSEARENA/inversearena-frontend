import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import express, { type Request, type Response } from "express";
import request from "supertest";

import { ApiKeyAuthProvider, requireAdmin } from "../../src/middleware/auth";
import { errorHandler } from "../../src/middleware/errorHandler";
import { createWorkerRouter } from "../../src/routes/worker";

const ADMIN_API_KEY = "worker-admin-api-key-0123456789abcd";

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

test("POST /api/worker/run rejects unauthenticated callers", async () => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/worker",
    createWorkerRouter(
      {
        runBatch: async (_req: Request, res: Response) => {
          res.json({ ok: true });
        },
      } as any,
      requireAdmin(new ApiKeyAuthProvider()),
    ),
  );
  app.use(errorHandler);

  const response = await request(app).post("/api/worker/run").send({ limit: 5 });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    },
  });
});

test("POST /api/worker/run allows admin callers and forwards the batch limit", async () => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;

  let capturedLimit: number | undefined;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/worker",
    createWorkerRouter(
      {
        runBatch: async (req: Request, res: Response) => {
          capturedLimit = req.body.limit;
          res.json({ processed: req.body.limit });
        },
      } as any,
      requireAdmin(new ApiKeyAuthProvider()),
    ),
  );
  app.use(errorHandler);

  const response = await request(app)
    .post("/api/worker/run")
    .set("Authorization", `Bearer ${ADMIN_API_KEY}`)
    .send({ limit: 7 });

  assert.equal(response.status, 200);
  assert.equal(capturedLimit, 7);
  assert.deepEqual(response.body, { processed: 7 });
});

test("POST /api/worker/arena-backfill/run rejects unauthenticated callers (#1391)", async () => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/worker",
    createWorkerRouter(
      {
        runBatch: async (_req: Request, res: Response) => {
          res.json({ ok: true });
        },
        runArenaBackfill: async (_req: Request, res: Response) => {
          res.json({ status: "success" });
        },
      } as any,
      requireAdmin(new ApiKeyAuthProvider()),
    ),
  );
  app.use(errorHandler);

  const response = await request(app).post("/api/worker/arena-backfill/run").send({});

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    },
  });
});

test("POST /api/worker/arena-backfill/run allows admin callers and returns the backfill run result (#1391)", async () => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;

  let called = false;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/worker",
    createWorkerRouter(
      {
        runBatch: async (_req: Request, res: Response) => {
          res.json({ ok: true });
        },
        runArenaBackfill: async (_req: Request, res: Response) => {
          called = true;
          res.json({ status: "success", discovered: 3, failed: 0, cursor: 3, pagesRead: 1, durationMs: 42 });
        },
      } as any,
      requireAdmin(new ApiKeyAuthProvider()),
    ),
  );
  app.use(errorHandler);

  const response = await request(app)
    .post("/api/worker/arena-backfill/run")
    .set("Authorization", `Bearer ${ADMIN_API_KEY}`)
    .send({});

  assert.equal(response.status, 200);
  assert.equal(called, true);
  assert.deepEqual(response.body, {
    status: "success",
    discovered: 3,
    failed: 0,
    cursor: 3,
    pagesRead: 1,
    durationMs: 42,
  });
});

test("POST /api/worker/retention/run rejects unauthenticated callers (#1622)", async () => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/worker",
    createWorkerRouter(
      {
        runBatch: async (_req: Request, res: Response) => {
          res.json({ ok: true });
        },
        runRetention: async (_req: Request, res: Response) => {
          res.json({ status: "success" });
        },
      } as any,
      requireAdmin(new ApiKeyAuthProvider()),
    ),
  );
  app.use(errorHandler);

  const response = await request(app).post("/api/worker/retention/run").send({ dryRun: true });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    },
  });
});

test("POST /api/worker/retention/run allows admin callers and forwards dryRun (#1622)", async () => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;

  let captured: { dryRun?: boolean } | undefined;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/worker",
    createWorkerRouter(
      {
        runBatch: async (_req: Request, res: Response) => {
          res.json({ ok: true });
        },
        runRetention: async (req: Request, res: Response) => {
          captured = req.body;
          res.json({ status: "success", dryRun: req.body.dryRun === true });
        },
      } as any,
      requireAdmin(new ApiKeyAuthProvider()),
    ),
  );
  app.use(errorHandler);

  const response = await request(app)
    .post("/api/worker/retention/run")
    .set("Authorization", `Bearer ${ADMIN_API_KEY}`)
    .send({ dryRun: true });

  assert.equal(response.status, 200);
  assert.deepEqual(captured, { dryRun: true });
  assert.deepEqual(response.body, { status: "success", dryRun: true });
});

test("POST /api/worker/retention/run defaults dryRun to false at the controller schema (#1622)", async () => {
  const { WorkerController } = await import("../../src/controllers/worker.controller");
  const seen: Array<{ dryRun?: boolean }> = [];
  const controller = new WorkerController(
    {} as any,
    {} as any,
    {
      run: async (options: { dryRun?: boolean }) => {
        seen.push(options);
        return { status: "success", dryRun: options.dryRun ?? false };
      },
    } as any,
  );

  const res = {
    locals: {} as Record<string, unknown>,
    json: (body: unknown) => body,
  };
  await controller.runRetention({ body: {} } as any, res as any);
  await controller.runRetention({ body: { dryRun: true } } as any, res as any);

  assert.deepEqual(seen, [{ dryRun: false }, { dryRun: true }]);
  assert.deepEqual(res.locals.auditMetadata, { dryRun: true });
});
