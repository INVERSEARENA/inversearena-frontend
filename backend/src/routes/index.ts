import { Router, RequestHandler } from "express";
import { createPayoutsRouter } from "./payouts";
import { createWorkerRouter } from "./worker";
import { createAuthRouter } from "./auth";
import { createUsersRouter } from "./users";
import { createTransactionsRouter } from "./transactions";
import { createOracleRouter } from "./oracle";
import { createArenasRouter } from "./arenas";
import { createLeaderboardRouter } from "./leaderboard";
import { createPoolsRouter } from "./pools";
import { createDocsRouter } from "./docs";
import { createArenaReplayRouter } from "./arenaReplay";
import { createNotificationPreferencesRouter } from "./notificationPreferences";
import { createPortfolioExposureRouter } from "./portfolioExposure";
import { createCancellationRecoveryRouter } from "./cancellationRecovery";
import { createConfigRouter } from "./config";
import { createInvitationsRouter } from "./invitations";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { WorkerController } from "../controllers/worker.controller";
import type { AuthController } from "../controllers/auth.controller";
import type { UsersController } from "../controllers/users.controller";
import type { LeaderboardController } from "../controllers/leaderboard.controller";
import type { TransactionsController } from "../controllers/transactions.controller";
import type { AuthService } from "../services/authService";

export function createApiRouter(
  payoutsController: PayoutsController,
  workerController: WorkerController,
  authController: AuthController,
  usersController: UsersController,
  leaderboardController: LeaderboardController,
  transactionsController: TransactionsController,
  adminAuthMiddleware: RequestHandler,
  requireAuth: RequestHandler,
  authService: AuthService,
): Router {
  const router = Router();

  router.use(createDocsRouter());
  router.use("/config", createConfigRouter());
  router.use("/auth", createAuthRouter(authController, requireAuth));
  router.use("/users", createUsersRouter(usersController, requireAuth));
  router.use("/payouts", createPayoutsRouter(payoutsController, authService, adminAuthMiddleware));
  router.use("/worker", createWorkerRouter(workerController, adminAuthMiddleware));
  router.use(
    "/transactions",
    requireAuth,
    createTransactionsRouter(transactionsController),
  );
  router.use("/oracle", createOracleRouter());
  router.use("/arenas", createArenasRouter(requireAuth));
  router.use("/arenas", createArenaReplayRouter(requireAuth));
  router.use("/arenas", createCancellationRecoveryRouter(requireAuth));
  router.use("/arenas", createInvitationsRouter(requireAuth));
  router.use("/pools", createPoolsRouter(requireAuth));
  router.use("/users", createNotificationPreferencesRouter(requireAuth));
  router.use("/users", createPortfolioExposureRouter(requireAuth));
  router.use(
    "/leaderboard",
    createLeaderboardRouter(leaderboardController, requireAuth),
  );

  return router;
}
