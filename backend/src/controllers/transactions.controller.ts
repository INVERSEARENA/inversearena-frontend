import type { NextFunction, Request, Response } from "express";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { apiError } from "../utils/apiError";

export class TransactionsController {
  constructor(private readonly transactions: TransactionRepository) {}

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tx = await this.transactions.findById(req.params.id!);
    if (!tx) {
      next(apiError(404, "TRANSACTION_NOT_FOUND", "Transaction not found"));
      return;
    }
    res.json(tx);
  };
}
