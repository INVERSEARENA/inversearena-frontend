import { z } from "zod";
import type { Request, Response } from "express";
import type { PaymentWorker } from "../workers/paymentWorker";

const RunBatchSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(25),
});

export class WorkerController {
  constructor(private readonly paymentWorker: PaymentWorker) {}

  runBatch = async (req: Request, res: Response): Promise<void> => {
    const { limit } = RunBatchSchema.parse(req.body);
    const result = await this.paymentWorker.processBatch(limit);
    res.json(result);
  };
}
