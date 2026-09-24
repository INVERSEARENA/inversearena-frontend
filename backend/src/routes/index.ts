import { Router, RequestHandler } from "express";
import { createPayoutsRouter } from "./payouts";
import { createWorkerRouter } from "./worker";
import { createAuthRouter } from "./auth";
import { createUsersRouter } from "./users";
import { createTransactionsRouter } from "./transactions";
import { createTransactionIntentsRouter } from "./transactionIntents";
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
import { createRoundProofBundleRouter } from "./roundProofBundle";
import { createLobbyReservationRouter } from "./lobbyReservation";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { WorkerController } from "../controllers/worker.controller";
import type { AuthController } from "../controllers/auth.controller";
import type { UsersController } from "../controllers/users.controller";
import type { LeaderboardController } from "../controllers/leaderboard.controller";
import type { TransactionsController } from "../controllers/transactions.controller";
import type { TransactionIntentsController } from "../controllers/transactionIntents.controller";
import type { AuthService } from "../services/authService";
import type { RoundProofBundleService } from "../services/roundProofBundleService";

export function createApiRouter(
  payoutsController: PayoutsController,
  workerController: WorkerController,
  authController: AuthController,
  usersController: UsersController,
  leaderboardController: LeaderboardController,
  transactionsController: TransactionsController,
  transactionIntentsController: TransactionIntentsController,
  adminAuthMiddleware: RequestHandler,
  requireAuth: RequestHandler,
  authService: AuthService,
  roundProofBundleService: RoundProofBundleService,
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
  // Deliberately not requireAuth-gated: the frontend has no wallet-login
  // (JWT) flow wired up anywhere yet (see docs/TRANSACTION_INTENTS.md §1).
  // Ownership is self-reported via `ownerWallet` in the request body/query.
  router.use(
    "/transaction-intents",
    createTransactionIntentsRouter(transactionIntentsController),
  );
  router.use("/oracle", createOracleRouter());
  router.use("/arenas", createArenasRouter(requireAuth));
  router.use("/arenas", createArenaReplayRouter(requireAuth));
  router.use("/arenas", createCancellationRecoveryRouter(requireAuth));
  router.use("/arenas", createInvitationsRouter(requireAuth));
  router.use("/arenas", createLobbyReservationRouter(requireAuth));
  router.use("/pools", createPoolsRouter(requireAuth));
  router.use("/rounds", createRoundProofBundleRouter(requireAuth, roundProofBundleService));
  router.use("/users", createNotificationPreferencesRouter(requireAuth));
  router.use("/users", createPortfolioExposureRouter(requireAuth));
  router.use(
    "/leaderboard",
    createLeaderboardRouter(leaderboardController, requireAuth),
  );
  router.use("/dashboard", createDashboardRouter(requireAuth));

  return router;
}
