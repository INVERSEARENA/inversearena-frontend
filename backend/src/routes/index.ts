import { Router } from "express";
import { createPayoutsRouter } from "./payouts";
import { createWorkerRouter } from "./worker";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { WorkerController } from "../controllers/worker.controller";

export function createApiRouter(
  payoutsController: PayoutsController,
  workerController: WorkerController
): Router {
  const router = Router();

  router.use("/payouts", createPayoutsRouter(payoutsController));
  router.use("/worker", createWorkerRouter(workerController));

  return router;
}
