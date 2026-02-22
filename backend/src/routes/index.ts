import { Router } from "express";
import { createPayoutsRouter } from "./payouts";
import { createWorkerRouter } from "./worker";
import { createOracleRouter } from "./oracle";
import { createArenasRouter } from "./arenas";
import { createLeaderboardRouter } from "./leaderboard";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { WorkerController } from "../controllers/worker.controller";

export function createApiRouter(
  payoutsController: PayoutsController,
  workerController: WorkerController
): Router {
  const router = Router();

  router.use("/payouts", createPayoutsRouter(payoutsController));
  router.use("/worker", createWorkerRouter(workerController));
  router.use("/oracle", createOracleRouter());
  router.use("/arenas", createArenasRouter());
  router.use("/leaderboard", createLeaderboardRouter());

  return router;
}
