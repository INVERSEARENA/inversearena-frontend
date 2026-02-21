import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { WorkerController } from "../controllers/worker.controller";

export function createWorkerRouter(controller: WorkerController): Router {
  const router = Router();

  router.post("/run", asyncHandler(controller.runBatch));

  return router;
}
