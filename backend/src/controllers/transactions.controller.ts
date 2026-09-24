import type { NextFunction, Request, Response } from "express";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { filterAccessibleTransactions, loadAccessibleTransaction } from "../utils/transactionAccess";

export class TransactionsController {
  constructor(private readonly transactions: TransactionRepository) {}

  getTimeline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startedAt = Date.now();
    // Same opaque 404 as getById for absent and foreign seeds (#1454).
    const seed = await loadAccessibleTransaction(this.transactions, req.params.id!, req, "timeline")
      .catch((error: unknown) => { next(error); return null; });
    if (!seed) return;
    try {
      const records = await this.transactions.listByStatus(["built", "queued", "awaiting_signature", "submitted", "confirmed", "failed", "dead"], 1000);
      // payoutId is caller-supplied, so a foreign payout can share it; only
      // records the requester could fetch individually may appear here.
      const visible = filterAccessibleTransactions(records.filter((item) => item.payoutId === seed.payoutId), req);
      const timeline = visible.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((item, index, items) => ({ ...item, replacesTransactionId: item.replacesTransactionId ?? items[index - 1]?.id ?? null, replacedByTransactionId: item.replacedByTransactionId ?? items[index + 1]?.id ?? null }));
      console.info(JSON.stringify({ event: "payout_timeline_success", payoutId: seed.payoutId, count: timeline.length, latencyMs: Date.now() - startedAt }));
      res.json({ version: 1, payoutId: seed.payoutId, timeline });
    } catch (error) {
      console.error(JSON.stringify({ event: "payout_timeline_failure", transactionId: seed.id, latencyMs: Date.now() - startedAt }));
      next(error);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Missing and forbidden are indistinguishable so ids cannot be probed.
    const tx = await loadAccessibleTransaction(this.transactions, req.params.id!, req, "status")
      .catch((error: unknown) => { next(error); return null; });
    if (!tx) return;
    res.json(tx);
  };
}
