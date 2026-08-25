import type { NextFunction, Request, Response } from "express";
import type { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { cache, cacheKeys } from "../cache/cacheService";
import { apiError } from "../utils/apiError";
import { canAccessTransaction } from "../utils/transactionAccess";

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
}
