/**
 * Regression for #1348: verifyAndConsumeToken must consume the confirmation
 * token atomically so a concurrent double-submit cannot authorize two
 * destructive admin actions.
 */
import type { Request, Response } from "express";
import { AdminController } from "../src/controllers/admin.controller";
import { ConfirmationTokenModel } from "../src/db/models/confirmationToken.model";
import { AuditLogModel } from "../src/db/models/auditLog.model";
import type { PaymentService } from "../src/services/paymentService";
import type { TransactionRepository } from "../src/repositories/transactionRepository";
import type { TransactionRecord } from "../src/types/payment";
import { AdminService } from "../src/services/adminService";

const TX_ID = "force-resolve-tx-1348";
const ADMIN_ID = "admin-1348";

function makeReq(token: string): Request {
  return {
    adminId: ADMIN_ID,
    params: { id: TX_ID },
    body: { token, targetStatus: "confirmed" },
    headers: {},
  } as unknown as Request;
}

function makeRes(): Response & { captured: unknown } {
  const res = {
    captured: undefined as unknown,
    json(body: unknown) {
      this.captured = body;
    },
    status() {
      return this;
    },
  };
  return res as unknown as Response & { captured: unknown };
}

describe("Admin confirmation token consume (#1348)", () => {
  afterEach(async () => {
    await ConfirmationTokenModel.deleteMany({});
    await AuditLogModel.deleteMany({});
  });

  it("allows only one of two concurrent force-resolve requests to execute", async () => {
    const adminService = new AdminService();
    const { token } = await adminService.requestToken(ADMIN_ID, "force_resolve", TX_ID);

    const update = jest.fn(async () => ({ id: TX_ID, status: "confirmed" } as TransactionRecord));
    const transactions = { update } as unknown as TransactionRepository;
    const controller = new AdminController(
      adminService,
      {} as PaymentService,
      transactions,
    );

    const results = await Promise.allSettled([
      controller.forceResolveTransaction(makeReq(token), makeRes()),
      controller.forceResolveTransaction(makeReq(token), makeRes()),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      message: "Confirmation token already used",
    });
    expect(update).toHaveBeenCalledTimes(1);

    const stored = await ConfirmationTokenModel.findOne({ action: "force_resolve" });
    expect(stored?.used).toBe(true);
  });

  it("accepts a valid token with matching action, resource, and admin", async () => {
    const service = new AdminService();
    const { token } = await service.requestToken(ADMIN_ID, "force_resolve", TX_ID);

    await expect(
      service.verifyAndConsumeToken(token, "force_resolve", TX_ID, ADMIN_ID),
    ).resolves.toBeUndefined();

    const stored = await ConfirmationTokenModel.findOne({ action: "force_resolve" });
    expect(stored?.used).toBe(true);
  });

  it("returns 404 for an unknown token", async () => {
    await expect(
      new AdminService().verifyAndConsumeToken("unknown", "force_resolve", TX_ID, ADMIN_ID),
    ).rejects.toMatchObject({ status: 404, message: "Confirmation token not found" });
  });

  it("returns 409 for a token that was already consumed", async () => {
    const service = new AdminService();
    const { token } = await service.requestToken(ADMIN_ID, "force_resolve", TX_ID);
    await service.verifyAndConsumeToken(token, "force_resolve", TX_ID, ADMIN_ID);

    await expect(
      service.verifyAndConsumeToken(token, "force_resolve", TX_ID, ADMIN_ID),
    ).rejects.toMatchObject({ status: 409, message: "Confirmation token already used" });
  });

  it("returns 410 for an expired token", async () => {
    const service = new AdminService();
    const { token } = await service.requestToken(ADMIN_ID, "force_resolve", TX_ID);
    await ConfirmationTokenModel.updateOne(
      { action: "force_resolve" },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    await expect(
      service.verifyAndConsumeToken(token, "force_resolve", TX_ID, ADMIN_ID),
    ).rejects.toMatchObject({ status: 410, message: "Confirmation token expired" });
  });

  it("returns 403 for an action or resource mismatch", async () => {
    const service = new AdminService();
    const { token } = await service.requestToken(ADMIN_ID, "force_resolve", TX_ID);

    await expect(
      service.verifyAndConsumeToken(token, "resubmit", TX_ID, ADMIN_ID),
    ).rejects.toMatchObject({
      status: 403,
      message: "Confirmation token action or resource mismatch",
    });
  });

  it("returns 403 when the token belongs to another admin", async () => {
    const service = new AdminService();
    const { token } = await service.requestToken(ADMIN_ID, "force_resolve", TX_ID);

    await expect(
      service.verifyAndConsumeToken(token, "force_resolve", TX_ID, "different-admin"),
    ).rejects.toMatchObject({
      status: 403,
      message: "Confirmation token belongs to a different admin",
    });
  });
});
