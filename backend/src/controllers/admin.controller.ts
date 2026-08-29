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

const ListAuditLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  action: z.string().optional(),
  adminId: z.string().optional(),
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

    await this.adminService.verifyAndConsumeToken(token, "force_resolve", id!, adminId);

    let transaction;
    try {
      transaction = await this.transactions.update(id!, {
        status: targetStatus,
        confirmedAt: targetStatus === "confirmed" ? new Date() : null,
        errorMessage: targetStatus === "failed" ? "Force-resolved by admin" : null,
        updatedAt: new Date(),
      });

      await this.adminService.log({
        adminId,
        action: "force_resolve",
        resourceType: "transaction",
        resourceId: id!,
        status: "success",
        metadata: { targetStatus },
        ...(req.ip !== undefined && { ipAddress: req.ip }),
        ...(req.headers["user-agent"] !== undefined && { userAgent: req.headers["user-agent"] }),
      });
    } catch (err) {
      await this.adminService.log({
        adminId,
        action: "force_resolve",
        resourceType: "transaction",
        resourceId: id!,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        ...(req.ip !== undefined && { ipAddress: req.ip }),
        ...(req.headers["user-agent"] !== undefined && { userAgent: req.headers["user-agent"] }),
      });
      throw err;
    }

    res.json({ transaction });
  };

  resubmitTransaction = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { token } = TokenOnlySchema.parse(req.body);
    const adminId = req.adminId!;

    await this.adminService.verifyAndConsumeToken(token, "resubmit", id!, adminId);

    let transaction;
    try {
      transaction = await this.transactions.update(id!, {
        status: "queued",
        attempts: 0,
        errorMessage: null,
        updatedAt: new Date(),
      });

      await this.adminService.log({
        adminId,
        action: "resubmit",
        resourceType: "transaction",
        resourceId: id!,
        status: "success",
        ...(req.ip !== undefined && { ipAddress: req.ip }),
        ...(req.headers["user-agent"] !== undefined && { userAgent: req.headers["user-agent"] }),
      });
    } catch (err) {
      await this.adminService.log({
        adminId,
        action: "resubmit",
        resourceType: "transaction",
        resourceId: id!,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        ...(req.ip !== undefined && { ipAddress: req.ip }),
        ...(req.headers["user-agent"] !== undefined && { userAgent: req.headers["user-agent"] }),
      });
      throw err;
    }

    res.json({ transaction });
  };

  /**
   * Pool reindex — **not implemented** (#1350).
   *
   * This previously consumed the confirmation token, wrote a `success` audit
   * entry and answered "Pool reindex queued", while no queue, worker or reindex
   * logic existed anywhere in the codebase. An admin reaching for this to repair
   * a stale pool record got a 200 and an audit trail saying it worked, and the
   * pool stayed exactly as broken as before — the worst possible failure mode
   * for a repair tool.
   *
   * Until a real indexer exists, the endpoint reports itself unimplemented:
   *
   *  - responds 501, so callers and monitoring see the truth;
   *  - does **not** consume the single-use confirmation token, so the admin does
   *    not have to mint a new one once this is implemented;
   *  - records the attempt as `failed`, so the audit log stops asserting that a
   *    repair happened.
   */
  reindexPool = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    TokenOnlySchema.parse(req.body);
    const adminId = req.adminId!;

    const message =
      "Pool reindex is not implemented: no indexer exists to rebuild pool state. " +
      "The confirmation token has not been consumed and no changes were made.";

    await this.adminService.log({
      adminId,
      action: "reindex_pool",
      resourceType: "pool",
      resourceId: id!,
      status: "failed",
      errorMessage: "not_implemented",
      ...(req.ip !== undefined && { ipAddress: req.ip }),
      ...(req.headers["user-agent"] !== undefined && { userAgent: req.headers["user-agent"] }),
    });

    res.status(501).json({
      error: "Not Implemented",
      message,
      poolId: id,
    });
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
        ...(req.ip !== undefined && { ipAddress: req.ip }),
        ...(req.headers["user-agent"] !== undefined && { userAgent: req.headers["user-agent"] }),
      });
    } catch (err) {
      await this.adminService.log({
        adminId,
        action: "reconciliation",
        resourceType: "global",
        resourceId: "global",
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        ...(req.ip !== undefined && { ipAddress: req.ip }),
        ...(req.headers["user-agent"] !== undefined && { userAgent: req.headers["user-agent"] }),
      });
      throw err;
    }

    res.json(result);
  };

  listAuditLogs = async (req: Request, res: Response): Promise<void> => {
    const { limit, action, adminId } = ListAuditLogsQuerySchema.parse(req.query);
    const filter: Record<string, unknown> = {};

    if (action !== undefined) filter.action = action;
    if (adminId !== undefined) filter.adminId = adminId;

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
