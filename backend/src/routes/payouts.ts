import { Router } from "express";
import type { RequestHandler } from "express";
import { asyncHandler, validateBody, validateParams } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { AuthService } from "../services/authService";
import { SignPayoutBodySchema, TransactionIdParamSchema } from "../validation/requestValidation";

export function createPayoutsRouter(
  controller: PayoutsController,
  authService: AuthService,
  adminAuthMiddleware: RequestHandler
): Router {
  const router = Router();

  // Payout lifecycle is admin-only: creation, signing and submission move funds.
  router.post("/", adminAuthMiddleware, asyncHandler(controller.createPayout));
  router.get("/:id", requireAuth(authService), validateParams(TransactionIdParamSchema), asyncHandler(controller.getPayout));
  router.post(
    "/:id/sign",
    adminAuthMiddleware,
    validateParams(TransactionIdParamSchema),
    validateBody(SignPayoutBodySchema),
    asyncHandler(controller.signPayout)
  );
  router.post(
    "/:id/submit",
    adminAuthMiddleware,
    validateParams(TransactionIdParamSchema),
    asyncHandler(controller.submitPayout)
  );

  return router;
}
