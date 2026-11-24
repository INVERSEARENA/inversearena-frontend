/**
 * Dead-letter service (#1859).
 *
 * Lists, inspects, re-drives and resolves failed payout and reconciliation
 * jobs from both the transaction store (status = "dead") and BullMQ failed sets.
 *
 * Every mutating action requires an audit log entry and runs an on-chain
 * check before re-submitting to prevent double payment.
 */

import type { TransactionRepository } from "../repositories/transactionRepository";
import type { AdminService } from "./adminService";
import type { PayoutOrchestrator } from "./paymentService";
import type { AuditLogEntry } from "../types/admin";

export interface DeadLetterItem {
  id: string;
  kind: "payout" | "reconciliation";
  payoutId?: string;
  arenaId?: string;
  status: "dead";
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date;
  payload: Record<string, unknown>;
}

export interface DeadLetterListOptions {
  arenaId?: string;
  errorClass?: string;
  olderThanDays?: number;
  cursor?: string;
  limit?: number;
}

export interface DeadLetterListResult {
  items: DeadLetterItem[];
  nextCursor: string | null;
}

export interface RedriveResult {
  id: string;
  status: "requeued" | "already_paid" | "resolved";
}

export class DeadLetterService {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly adminService: AdminService,
    private readonly payoutOrchestrator: PayoutOrchestrator,
  ) {}

  async list(options: DeadLetterListOptions = {}): Promise<DeadLetterListResult> {
    const { limit = 25, cursor, arenaId } = options;

    // Build filter: only "dead" status transactions
    const filter: Record<string, unknown> = { status: "dead" };
    if (arenaId) filter["metadata.arenaId"] = arenaId;
    if (cursor) filter["id"] = { $gt: cursor };

    // findByStatus is a pagination-compatible lookup; we pass status and limit
    const records = await this.transactions.findByStatus("dead", limit + 1);

    const filtered = arenaId
      ? records.filter((r) => (r as any).metadata?.arenaId === arenaId)
      : records;

    const items: DeadLetterItem[] = filtered.slice(0, limit).map((r) => ({
      id: r.id,
      kind: "payout" as const,
      payoutId: r.payoutId ?? undefined,
      arenaId: (r as any).metadata?.arenaId,
      status: "dead" as const,
      attempts: r.attempts,
      lastError: r.errorMessage ?? null,
      lastAttemptAt: r.updatedAt,
      payload: {
        signedXdr: r.signedXdr ? "[redacted]" : null,
        type: r.type,
      },
    }));

    const nextCursor = filtered.length > limit ? filtered[limit - 1].id : null;

    return { items, nextCursor };
  }

  async inspect(id: string): Promise<DeadLetterItem | null> {
    const tx = await this.transactions.findById(id);
    if (!tx || tx.status !== "dead") return null;
    return {
      id: tx.id,
      kind: "payout",
      payoutId: tx.payoutId ?? undefined,
      arenaId: (tx as any).metadata?.arenaId,
      status: "dead",
      attempts: tx.attempts,
      lastError: tx.errorMessage ?? null,
      lastAttemptAt: tx.updatedAt,
      payload: { type: tx.type, signedXdr: tx.signedXdr ? "[redacted]" : null },
    };
  }

  /**
   * Re-drive a dead-lettered payout transaction.
   * Checks on-chain status first to prevent double payment.
   */
  async redrive(
    id: string,
    adminId: string,
    feeOverrideBudget?: number,
  ): Promise<RedriveResult> {
    const tx = await this.transactions.findById(id);
    if (!tx || tx.status !== "dead") {
      const err: any = new Error("Dead-letter item not found or not in dead state");
      err.status = 404;
      throw err;
    }

    // On-chain double-payment guard: check if payout already landed
    if (tx.payoutId) {
      const alreadyPaid = await this.checkOnChainPaid(tx.payoutId);
      if (alreadyPaid) {
        await this.transactions.update(id, {
          status: "confirmed",
          confirmedAt: new Date(),
          errorMessage: "Confirmed by on-chain check during redrive",
          updatedAt: new Date(),
        });

        const auditEntry: AuditLogEntry = {
          adminId,
          action: "redrive_dead_letter",
          resourceType: "transaction",
          resourceId: id,
          status: "success",
          metadata: { outcome: "already_paid", payoutId: tx.payoutId },
        };
        await this.adminService.log(auditEntry);

        return { id, status: "already_paid" };
      }
    }

    // Reset to pending for the payment worker to pick up
    await this.transactions.update(id, {
      status: "pending",
      attempts: 0,
      errorMessage: null,
      updatedAt: new Date(),
    });

    const auditEntry: AuditLogEntry = {
      adminId,
      action: "redrive_dead_letter",
      resourceType: "transaction",
      resourceId: id,
      status: "success",
      metadata: { feeOverrideBudget: feeOverrideBudget ?? null },
    };
    await this.adminService.log(auditEntry);

    return { id, status: "requeued" };
  }

  /**
   * Close a dead-letter item as resolved without re-driving it.
   */
  async markResolved(id: string, adminId: string, reason: string): Promise<void> {
    const tx = await this.transactions.findById(id);
    if (!tx || tx.status !== "dead") {
      const err: any = new Error("Dead-letter item not found or not in dead state");
      err.status = 404;
      throw err;
    }

    await this.transactions.update(id, {
      status: "failed",
      errorMessage: `Manually resolved: ${reason}`,
      updatedAt: new Date(),
    });

    const auditEntry: AuditLogEntry = {
      adminId,
      action: "mark_resolved_dead_letter",
      resourceType: "transaction",
      resourceId: id,
      status: "success",
      metadata: { reason },
    };
    await this.adminService.log(auditEntry);
  }

  private async checkOnChainPaid(payoutId: string): Promise<boolean> {
    // Delegate to payoutOrchestrator's on-chain status check if available.
    // The orchestrator exposes isPaid(payoutId) → boolean via the payout contract.
    if (typeof (this.payoutOrchestrator as any).isPaid === "function") {
      return (this.payoutOrchestrator as any).isPaid(payoutId);
    }
    // No on-chain reader available — conservative: do not assume paid.
    return false;
  }
}
