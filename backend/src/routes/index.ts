import { Router, RequestHandler } from "express";
import { createPayoutsRouter } from "./payouts";
import { createWorkerRouter } from "./worker";
import { createAuthRouter } from "./auth";
import { createUsersRouter } from "./users";
import { createTransactionsRouter } from "./transactions";
import { createOracleRouter } from "./oracle";
import { createArenasRouter } from "./arenas";
import { createLeaderboardRouter } from "./leaderboard";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { WorkerController } from "../controllers/worker.controller";
import type { AuthController } from "../controllers/auth.controller";
import type { UsersController } from "../controllers/users.controller";
import type { LeaderboardController } from "../controllers/leaderboard.controller";
import type { TransactionsController } from "../controllers/transactions.controller";

export function createApiRouter(
  payoutsController: PayoutsController,
  workerController: WorkerController,
  authController: AuthController,
  usersController: UsersController,
  leaderboardController: LeaderboardController,
  transactionsController: TransactionsController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.use("/auth", createAuthRouter(authController, requireAuth));
  router.use("/users", createUsersRouter(usersController, requireAuth));
  router.use("/payouts", createPayoutsRouter(payoutsController));
  router.use("/worker", createWorkerRouter(workerController));
  router.use(
    "/transactions",
    requireAuth,
    createTransactionsRouter(transactionsController),
  );
  router.use("/oracle", createOracleRouter());
  router.use("/arenas", createArenasRouter());
  router.use(
    "/leaderboard",
    createLeaderboardRouter(leaderboardController, requireAuth),
  );

  return router;
}
