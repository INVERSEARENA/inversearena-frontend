import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createApiRouter } from "./routes";
import { createAdminRouter } from "./routes/admin";
import { errorHandler } from "./middleware/errorHandler";
import { ApiKeyAuthProvider, requireAdmin } from "./middleware/auth";
import { PayoutsController } from "./controllers/payouts.controller";
import { WorkerController } from "./controllers/worker.controller";
import { AdminController } from "./controllers/admin.controller";
import type { PaymentService } from "./services/paymentService";
import type { PaymentWorker } from "./workers/paymentWorker";
import type { TransactionRepository } from "./repositories/transactionRepository";
import type { AdminService } from "./services/adminService";

export interface AppDependencies {
  paymentService: PaymentService;
  paymentWorker: PaymentWorker;
  transactions: TransactionRepository;
  adminService: AdminService;
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
  const adminController = new AdminController(
    deps.adminService,
    deps.paymentService,
    deps.transactions
  );

  const authMiddleware = requireAdmin(new ApiKeyAuthProvider());

  app.use("/api", createApiRouter(payoutsController, workerController));
  app.use("/api/admin", createAdminRouter(adminController, authMiddleware));

  app.use(errorHandler);

  return app;
}
