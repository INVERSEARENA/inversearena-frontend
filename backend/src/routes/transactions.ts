import { Router } from "express";
import { asyncHandler, validateParams } from "../middleware/validate";
import type { TransactionsController } from "../controllers/transactions.controller";
import { TransactionIdParamSchema } from "../validation/requestValidation";

export function createTransactionsRouter(controller: TransactionsController): Router {
  const router = Router();

  router.get("/:id", validateParams(TransactionIdParamSchema), asyncHandler(controller.getById));

  return router;
}
