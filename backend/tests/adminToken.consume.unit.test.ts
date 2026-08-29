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
});
