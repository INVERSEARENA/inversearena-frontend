import express from "express";
import request from "supertest";
import { createHmac } from "crypto";

import { createWebhooksRouter } from "../webhooks";
import { errorHandler } from "../../middleware/errorHandler";
import type { RevalidationService } from "../../services/revalidationService";

const SECRET = "webhook-shared-secret-value";

function buildApp(service: RevalidationService): express.Express {
  const app = express();
  app.use(
    "/api/webhooks",
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use("/api/webhooks", createWebhooksRouter(service));
  app.use(errorHandler);
  return app;
}

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("POST /api/webhooks/config-changed (#1626)", () => {
  let service: RevalidationService;

  beforeEach(() => {
    process.env.ORACLE_WEBHOOK_SECRET = SECRET;
    delete process.env.ORACLE_WEBHOOK_SECRET_PREVIOUS;
    delete process.env.ORACLE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT;
    service = {
      revalidateConfig: jest.fn(async (reason: string, contracts: string[] = []) => ({
        purgedTags: ["arenas:list", "leaderboard"],
        invalidatedContracts: contracts,
        frontendNotified: true,
        requestId: "req-1",
      })),
    } as unknown as RevalidationService;
  });

  afterEach(() => {
    delete process.env.ORACLE_WEBHOOK_SECRET;
  });

  it("rejects a request with no signature", async () => {
    const res = await request(buildApp(service))
      .post("/api/webhooks/config-changed")
      .send({ reason: "fee_schedule" });

    expect(res.status).toBe(401);
    expect(service.revalidateConfig).not.toHaveBeenCalled();
  });

  it("rejects a request with a bad signature", async () => {
    const body = JSON.stringify({ reason: "fee_schedule" });
    const res = await request(buildApp(service))
      .post("/api/webhooks/config-changed")
      .set("x-oracle-signature", "sha256=deadbeef")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(service.revalidateConfig).not.toHaveBeenCalled();
  });

  it("revalidates when the signature matches", async () => {
    const body = JSON.stringify({ reason: "factory_upgrade", contracts: [CONTRACT] });
    const res = await request(buildApp(service))
      .post("/api/webhooks/config-changed")
      .set("x-oracle-signature", sign(body))
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.revalidated).toBe(true);
    expect(service.revalidateConfig).toHaveBeenCalledWith("factory_upgrade", [CONTRACT]);
  });

  it("rejects an authenticated request with an invalid body", async () => {
    const body = JSON.stringify({ reason: "" });
    const res = await request(buildApp(service))
      .post("/api/webhooks/config-changed")
      .set("x-oracle-signature", sign(body))
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(service.revalidateConfig).not.toHaveBeenCalled();
  });
});
