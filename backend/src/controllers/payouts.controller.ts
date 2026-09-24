import type { NextFunction, Request, Response } from "express";
import type { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { cache, cacheKeys } from "../cache/cacheService";
import { apiError } from "../utils/apiError";
import { canAccessTransaction } from "../utils/transactionAccess";
import { buildSettlementManifest, toReceiptCsv } from "../services/settlementService";

export class PayoutsController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly transactions: TransactionRepository
  ) {}

  createPayout = async (req: Request, res: Response): Promise<void> => {
    // Admin API-key requests stamp the key identity; user JWT requests are
    // blocked upstream by the admin gate but stay supported for defense in depth.
    const result = await this.paymentService.createPayoutTransaction(
      req.body,
      req.adminId ?? req.user?.id ?? null
    );

    // Invalidate arena stats and leaderboard caches on payout creation
    await Promise.allSettled([
      cache.delByPattern("arena:stats:*"),
      cache.del(cacheKeys.leaderboard()),
    ]);

    res.status(201).json(result);
  };

  getPayout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.params;
    const transaction = await this.transactions.findById(id!);
    if (!transaction || !canAccessTransaction(transaction, req)) {
      // Missing and forbidden are indistinguishable so ids cannot be probed.
      next(apiError(404, "TRANSACTION_NOT_FOUND", `Transaction ${id} not found`));
      return;
    }
    res.json(transaction);
  };

  signPayout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.params;
    const transaction = await this.transactions.findById(id!);
    if (!transaction || !canAccessTransaction(transaction, req)) {
      next(apiError(404, "TRANSACTION_NOT_FOUND", `Transaction ${id} not found`));
      return;
    }
    const { signedXdr } = req.body as { signedXdr: string };
    const updated = await this.paymentService.queueSignedTransaction(id!, signedXdr);
    res.json(updated);
  };

  submitPayout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.params;
    const transaction = await this.transactions.findById(id!);
    if (!transaction || !canAccessTransaction(transaction, req)) {
      next(apiError(404, "TRANSACTION_NOT_FOUND", `Transaction ${id} not found`));
      return;
    }
    const result = await this.paymentService.submitQueuedTransaction(id!);
    res.json(result);
  };

  /**
   * Settlement receipt (#1407). Requires the payout to be confirmed on-chain
   * — before that there's no txHash to reconcile against, so a receipt would
   * report an unconfirmed lump sum as if it were a settled fact.
   */
  private async loadConfirmedTransaction(req: Request, res: Response, next: NextFunction) {
    const { id } = req.params;
    const transaction = await this.transactions.findById(id!);
    if (!transaction || !canAccessTransaction(transaction, req)) {
      next(apiError(404, "TRANSACTION_NOT_FOUND", `Transaction ${id} not found`));
      return null;
    }
    if (transaction.status !== "confirmed") {
      next(
        apiError(
          409,
          "PAYOUT_NOT_SETTLED",
          `Transaction ${id} is not yet confirmed (status: ${transaction.status}); no receipt is available until it settles on-chain`,
        ),
      );
      return null;
    }
    return transaction;
  }

  getReceipt = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const transaction = await this.loadConfirmedTransaction(req, res, next);
    if (!transaction) return;
    res.json(buildSettlementManifest(transaction));
  };

  getReceiptCsv = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const transaction = await this.loadConfirmedTransaction(req, res, next);
    if (!transaction) return;
    const csv = toReceiptCsv(buildSettlementManifest(transaction));
    // payoutId is caller-supplied at payout creation; only use a sanitized
    // form in the header value to rule out header/CRLF injection via the
    // filename parameter.
    const safePayoutId = transaction.payoutId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="receipt-${safePayoutId}.csv"`);
    res.send(csv);
  };
}
