import { Router, type RequestHandler } from "express";
import { asyncHandler } from "../middleware/validate";
import type { WorkerController } from "../controllers/worker.controller";

export function createWorkerRouter(
  controller: WorkerController,
  adminAuthMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.post("/run", adminAuthMiddleware, asyncHandler(controller.runBatch));

  return router;
}
