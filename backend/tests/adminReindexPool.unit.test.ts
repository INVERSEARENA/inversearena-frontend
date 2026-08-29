import express from "express";
import request from "supertest";
import { test } from "node:test";
import assert from "node:assert";
import { AdminController } from "../src/controllers/admin.controller";

/**
 * reindexPool honesty (#1350).
 *
 * The handler used to consume the single-use confirmation token, write a
 * `success` audit entry and answer 200 "Pool reindex queued" — while no queue,
 * worker or reindex logic existed anywhere in the codebase. An admin reaching
 * for it to repair a stale pool got a success response, a success audit trail,
 * and an unchanged pool.
 *
 * It now reports itself unimplemented instead.
 */

type LoggedEntry = Record<string, unknown>;

function buildApp() {
  const logged: LoggedEntry[] = [];
  const consumedTokens: string[] = [];

  const adminService = {
    log: async (entry: LoggedEntry) => {
      logged.push(entry);
    },
    verifyAndConsumeToken: async (token: string) => {
      consumedTokens.push(token);
    },
  } as any;

  const controller = new AdminController(adminService, {} as any, {} as any);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.adminId = "admin-1";
    next();
  });
  app.post("/pools/:id/reindex", (req, res, next) => {
    controller.reindexPool(req as any, res as any).catch(next);
  });

  return { app, logged, consumedTokens };
}

test("reindexPool responds 501 instead of claiming the reindex was queued", async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post("/pools/pool-1/reindex")
    .send({ token: "tok-1" });

  assert.equal(res.status, 501);
  assert.equal(res.body.error, "Not Implemented");
  assert.match(res.body.message, /not implemented/i);
  assert.equal(res.body.poolId, "pool-1");
});

test("reindexPool never reports success in the response body", async () => {
  const { app } = buildApp();

  const res = await request(app)
    .post("/pools/pool-1/reindex")
    .send({ token: "tok-1" });

  const body = JSON.stringify(res.body).toLowerCase();
  assert.ok(!body.includes("queued"), "must not claim the reindex was queued");
  assert.ok(res.status >= 400, "must not answer with a 2xx");
});

test("reindexPool records the attempt as failed, not success", async () => {
  const { app, logged } = buildApp();

  await request(app).post("/pools/pool-1/reindex").send({ token: "tok-1" });

  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "reindex_pool");
  assert.equal(logged[0].resourceId, "pool-1");
  assert.equal(
    logged[0].status,
    "failed",
    "the audit log must not assert that a repair happened",
  );
  assert.equal(logged[0].errorMessage, "not_implemented");
});

test("reindexPool does not consume the single-use confirmation token", async () => {
  const { app, consumedTokens } = buildApp();

  await request(app).post("/pools/pool-1/reindex").send({ token: "tok-1" });

  // Burning a token for an operation that does nothing would force the admin to
  // mint a fresh one once this is actually implemented.
  assert.deepEqual(consumedTokens, []);
});

test("reindexPool still validates its request body", async () => {
  const { app } = buildApp();

  const res = await request(app).post("/pools/pool-1/reindex").send({});

  assert.notEqual(res.status, 501, "a malformed request must not read as unimplemented");
});
