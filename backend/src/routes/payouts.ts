import { Router } from "express";
import { asyncHandler, validateBody, validateParams } from "../middleware/validate";
import type { PayoutsController } from "../controllers/payouts.controller";
import { SignPayoutBodySchema, TransactionIdParamSchema } from "../validation/requestValidation";

export function createPayoutsRouter(controller: PayoutsController): Router {
  const router = Router();

  router.post("/", asyncHandler(controller.createPayout));
  router.get("/:id", validateParams(TransactionIdParamSchema), asyncHandler(controller.getPayout));
  router.post(
    "/:id/sign",
    validateParams(TransactionIdParamSchema),
    validateBody(SignPayoutBodySchema),
    asyncHandler(controller.signPayout)
  );
  router.post(
    "/:id/submit",
    validateParams(TransactionIdParamSchema),
    asyncHandler(controller.submitPayout)
  );

  return router;
}
