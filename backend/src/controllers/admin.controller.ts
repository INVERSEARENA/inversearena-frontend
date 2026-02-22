import type { Request, Response } from "express";
import { z } from "zod";
import type { AdminService } from "../services/adminService";
import type { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { AuditLogModel } from "../db/models/auditLog.model";

const RequestTokenSchema = z.object({
  action: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(128),
});

const ForceResolveSchema = z.object({
  token: z.string().min(1),
  targetStatus: z.enum(["confirmed", "failed"]),
});

const TokenOnlySchema = z.object({
  token: z.string().min(1),
});

const ReconciliationSchema = z.object({
  token: z.string().min(1),
  dryRun: z.boolean().optional().default(false),
});

export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly paymentService: PaymentService,
    private readonly transactions: TransactionRepository
  ) {}

  requestToken = async (req: Request, res: Response): Promise<void> => {
    const { action, resourceId } = RequestTokenSchema.parse(req.body);
    const adminId = req.adminId!;
    const result = await this.adminService.requestToken(adminId, action, resourceId);
    res.status(201).json(result);
  };

  forceResolveTransaction = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { token, targetStatus } = ForceResolveSchema.parse(req.body);
    const adminId = req.adminId!;

    await this.adminService.verifyAndConsumeToken(token, "force_resolve", id, adminId);

    let transaction;
    try {
      transaction = await this.transactions.update(id, {
        status: targetStatus,
        confirmedAt: targetStatus === "confirmed" ? new Date() : undefined,
        errorMessage: targetStatus === "failed" ? "Force-resolved by admin" : null,
        updatedAt: new Date(),
      });

      await this.adminService.log({
        adminId,
        action: "force_resolve",
        resourceType: "transaction",
        resourceId: id,
        status: "success",
        metadata: { targetStatus },
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
    } catch (err) {
      await this.adminService.log({
        adminId,
        action: "force_resolve",
        resourceType: "transaction",
        resourceId: id,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      throw err;
    }

    res.json({ transaction });
  };

  resubmitTransaction = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { token } = TokenOnlySchema.parse(req.body);
    const adminId = req.adminId!;

    await this.adminService.verifyAndConsumeToken(token, "resubmit", id, adminId);

    let transaction;
    try {
      transaction = await this.transactions.update(id, {
        status: "queued",
        attempts: 0,
        errorMessage: null,
        updatedAt: new Date(),
      });

      await this.adminService.log({
        adminId,
        action: "resubmit",
        resourceType: "transaction",
        resourceId: id,
        status: "success",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
    } catch (err) {
      await this.adminService.log({
        adminId,
        action: "resubmit",
        resourceType: "transaction",
        resourceId: id,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      throw err;
    }

    res.json({ transaction });
  };

  reindexPool = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { token } = TokenOnlySchema.parse(req.body);
    const adminId = req.adminId!;

    await this.adminService.verifyAndConsumeToken(token, "reindex_pool", id, adminId);

    await this.adminService.log({
      adminId,
      action: "reindex_pool",
      resourceType: "pool",
      resourceId: id,
      status: "success",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json({ message: "Pool reindex queued", poolId: id });
  };

  runReconciliation = async (req: Request, res: Response): Promise<void> => {
    const { token, dryRun } = ReconciliationSchema.parse(req.body);
    const adminId = req.adminId!;

    await this.adminService.verifyAndConsumeToken(token, "reconciliation", "global", adminId);

    let result;
    try {
      const submitted = await this.transactions.listByStatus(["submitted"], 500);
      let confirmed = 0;
      let failed = 0;

      if (!dryRun) {
        for (const tx of submitted) {
          const refreshed = await this.paymentService.confirmSubmittedTransaction(tx.id);
          if (refreshed.status === "confirmed") confirmed++;
          else if (refreshed.status === "failed") failed++;
        }
      }

      result = { checked: submitted.length, confirmed, failed, dryRun };

      await this.adminService.log({
        adminId,
        action: "reconciliation",
        resourceType: "global",
        resourceId: "global",
        status: "success",
        metadata: result,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
    } catch (err) {
      await this.adminService.log({
        adminId,
        action: "reconciliation",
        resourceType: "global",
        resourceId: "global",
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      throw err;
    }

    res.json(result);
  };

  listAuditLogs = async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const filter: Record<string, unknown> = {};

    if (typeof req.query.action === "string") filter.action = req.query.action;
    if (typeof req.query.adminId === "string") filter.adminId = req.query.adminId;

    const [logs, total] = await Promise.all([
      AuditLogModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      AuditLogModel.countDocuments(filter),
    ]);

    res.json({
      logs: logs.map((l) => ({ ...l, id: String(l._id) })),
      total,
    });
  };
}
