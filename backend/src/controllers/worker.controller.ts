import { z } from "zod";
import type { Request, Response } from "express";
import type { PaymentWorker } from "../workers/paymentWorker";
import type { ArenaBackfillWorker } from "../workers/arenaBackfillWorker";

const RunBatchSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(25),
});

export class WorkerController {
  constructor(
    private readonly paymentWorker: PaymentWorker,
    private readonly arenaBackfillWorker: ArenaBackfillWorker,
  ) {}

  runBatch = async (req: Request, res: Response): Promise<void> => {
    const { limit } = RunBatchSchema.parse(req.body);
    const result = await this.paymentWorker.processBatch(limit);
    res.json(result);
  };

  runArenaBackfill = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.arenaBackfillWorker.run();
    res.json(result);
  };
}
