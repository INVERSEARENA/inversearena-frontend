import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createApiRouter } from "./routes";
import { createAdminRouter } from "./routes/admin";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/logger";
import { requestContextMiddleware } from "./middleware/requestContext";
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
import { refreshArenaMetrics, register } from "./utils/metrics";
import { redis } from "./cache/redisClient";
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

  // Configure Helmet with security headers
  app.use(
    helmet({
      // HSTS: Force HTTPS for 1 year, including subdomains
      hsts: {
        maxAge: 31536000, // 1 year in seconds
        includeSubDomains: true,
        preload: true,
      },
      // Referrer Policy: Balance privacy and analytics
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin",
      },
      // Cross-Origin Opener Policy: Improve isolation
      crossOriginOpenerPolicy: {
        policy: "same-origin",
      },
      // Cross-Origin Resource Policy: Allow frontend to load from API
      crossOriginResourcePolicy: {
        policy: "cross-origin",
      },
      // Content Security Policy: Disabled (handled by Next.js frontend)
      contentSecurityPolicy: false,
      // Permitted Cross-Domain Policies: Disable Adobe Flash/PDF policies
      permittedCrossDomainPolicies: {
        permittedPolicies: "none",
      },
    })
  );
  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);
  app.use(requestContextMiddleware);
  app.use(metricsMiddleware);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/ready", async (_req, res) => {
    try {
      const [dbResult, redisResult] = await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        redis.ping(),
      ]);

      const breakerStats = deps.paymentService.getSorobanBreakerStats();

      res.status(200).json({
        status: "ready",
        database: dbResult,
        redis: redisResult,
        sorobanCircuitBreaker: breakerStats,
      });
    } catch (error) {
      res.status(503).json({
        status: "not_ready",
        error: error instanceof Error ? error.message : "Readiness check failed",
      });
    }
  });

  app.get("/metrics", async (_req, res) => {
    try {
      await refreshArenaMetrics(prisma);
    } catch {
      // Keep the metrics endpoint available even if the database is degraded.
    }
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
