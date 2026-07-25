import { Router } from "express";
import { asyncHandler, validateBody, validateParams } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { AuthService } from "../services/authService";
import { SignPayoutBodySchema, TransactionIdParamSchema } from "../validation/requestValidation";

export function createPayoutsRouter(controller: PayoutsController, authService: AuthService): Router {
  const router = Router();

  router.post("/", requireAuth(authService), asyncHandler(controller.createPayout));
  router.get("/:id", requireAuth(authService), validateParams(TransactionIdParamSchema), asyncHandler(controller.getPayout));
  router.post(
    "/:id/sign",
    requireAuth(authService),
    validateParams(TransactionIdParamSchema),
    validateBody(SignPayoutBodySchema),
    asyncHandler(controller.signPayout)
  );
  router.post(
    "/:id/submit",
    requireAuth(authService),
    validateParams(TransactionIdParamSchema),
    asyncHandler(controller.submitPayout)
  );

  return router;
}
