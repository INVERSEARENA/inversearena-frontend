import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createApiRouter } from "./routes";
import { createAdminRouter } from "./routes/admin";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/logger";
import { metricsMiddleware } from "./middleware/metrics";
import {
  ApiKeyAuthProvider,
  requireAdmin,
  requireAuth,
} from "./middleware/auth";
import { PayoutsController } from "./controllers/payouts.controller";
import { WorkerController } from "./controllers/worker.controller";
import { AdminController } from "./controllers/admin.controller";
import { AuthController } from "./controllers/auth.controller";
import { UsersController } from "./controllers/users.controller";
import { LeaderboardController } from "./controllers/leaderboard.controller";
import { TransactionsController } from "./controllers/transactions.controller";
import { RoundController } from "./controllers/round.controller";
import { register } from "./utils/metrics";
import type { PaymentService } from "./services/paymentService";
import type { PaymentWorker } from "./workers/paymentWorker";
import type { TransactionRepository } from "./repositories/transactionRepository";
import type { AdminService } from "./services/adminService";
import type { AuthService } from "./services/authService";
import type { RoundService } from "./services/roundService";
import { prisma } from "./db/prisma";

export interface AppDependencies {
  paymentService: PaymentService;
  paymentWorker: PaymentWorker;
  transactions: TransactionRepository;
  adminService: AdminService;
  authService: AuthService;
  roundService: RoundService;
}

export function createApp(deps: AppDependencies): express.Application {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);
  app.use(metricsMiddleware);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });

  const payoutsController = new PayoutsController(
    deps.paymentService,
    deps.transactions,
  );
  const workerController = new WorkerController(deps.paymentWorker);
  const adminController = new AdminController(
    deps.adminService,
    deps.paymentService,
    deps.transactions,
  );
  const authController = new AuthController(deps.authService);
  const usersController = new UsersController(prisma);
  const leaderboardController = new LeaderboardController(prisma);
  const transactionsController = new TransactionsController(deps.transactions);
  const roundController = new RoundController(deps.roundService);

  const adminAuthMiddleware = requireAdmin(new ApiKeyAuthProvider());
  const userAuthMiddleware = requireAuth(deps.authService);

  app.use(
    "/api",
    createApiRouter(
      payoutsController,
      workerController,
      authController,
      usersController,
      leaderboardController,
      transactionsController,
      userAuthMiddleware,
    ),
  );
  app.use(
    "/api/admin",
    createAdminRouter(adminController, roundController, adminAuthMiddleware),
  );

  app.use(errorHandler);

  return app;
}
