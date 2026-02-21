import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createApiRouter } from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { PayoutsController } from "./controllers/payouts.controller";
import { WorkerController } from "./controllers/worker.controller";
import type { PaymentService } from "./services/paymentService";
import type { PaymentWorker } from "./workers/paymentWorker";
import type { TransactionRepository } from "./repositories/transactionRepository";

export interface AppDependencies {
  paymentService: PaymentService;
  paymentWorker: PaymentWorker;
  transactions: TransactionRepository;
}

export function createApp(deps: AppDependencies): express.Application {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const payoutsController = new PayoutsController(deps.paymentService, deps.transactions);
  const workerController = new WorkerController(deps.paymentWorker);

  app.use("/api", createApiRouter(payoutsController, workerController));

  app.use(errorHandler);

  return app;
}
