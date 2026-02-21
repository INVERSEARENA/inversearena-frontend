import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { PayoutsController } from "../controllers/payouts.controller";

export function createPayoutsRouter(controller: PayoutsController): Router {
  const router = Router();

  router.post("/", asyncHandler(controller.createPayout));
  router.get("/:id", asyncHandler(controller.getPayout));
  router.post("/:id/sign", asyncHandler(controller.signPayout));
  router.post("/:id/submit", asyncHandler(controller.submitPayout));

  return router;
}
