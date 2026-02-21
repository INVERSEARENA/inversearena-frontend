import type { Request, Response } from "express";
import type { PaymentWorker } from "../workers/paymentWorker";

export class WorkerController {
  constructor(private readonly paymentWorker: PaymentWorker) {}

  runBatch = async (req: Request, res: Response): Promise<void> => {
    const limit = Number(req.body?.limit ?? 25);
    const result = await this.paymentWorker.processBatch(limit);
    res.json(result);
  };
}
