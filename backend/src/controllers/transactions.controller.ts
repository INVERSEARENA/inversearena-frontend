import type { Request, Response } from "express";
import type { TransactionRepository } from "../repositories/transactionRepository";

export class TransactionsController {
  constructor(private readonly transactions: TransactionRepository) {}

  getById = async (req: Request, res: Response): Promise<void> => {
    const tx = await this.transactions.findById(req.params.id!);
    if (!tx) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }
    res.json(tx);
  };
}
