import type { Request, Response } from "express";
import type { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";

export class PayoutsController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly transactions: TransactionRepository
  ) {}

  createPayout = async (req: Request, res: Response): Promise<void> => {
    const result = await this.paymentService.createPayoutTransaction(req.body);
    res.status(201).json(result);
  };

  getPayout = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const transaction = await this.transactions.findById(id);
    if (!transaction) {
      res.status(404).json({ error: `Transaction ${id} not found` });
      return;
    }
    res.json(transaction);
  };

  signPayout = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { signedXdr } = req.body as { signedXdr: string };
    const transaction = await this.paymentService.queueSignedTransaction(id, signedXdr);
    res.json(transaction);
  };

  submitPayout = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const result = await this.paymentService.submitQueuedTransaction(id);
    res.json(result);
  };
}
