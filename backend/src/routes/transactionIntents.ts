import { Router } from "express";
import { asyncHandler, validateBody, validateParams, validateQuery } from "../middleware/validate";
import type { TransactionIntentsController } from "../controllers/transactionIntents.controller";
import {
  AttachSignedXdrBodySchema,
  IntentIdParamSchema,
  IntentOwnerQuerySchema,
  MarkAwaitingSignatureBodySchema,
  RecordSignatureFailureBodySchema,
  RecordSubmissionOutcomeBodySchema,
} from "../validation/requestValidation";

export function createTransactionIntentsRouter(controller: TransactionIntentsController): Router {
  const router = Router();

  // ownerWallet + idempotencyKey/kind/unsignedXdr are validated inside the
  // service via CreateIntentRequestSchema, since createOrResumeIntent must
  // run that same validation whether it's called from this route or (in
  // tests) directly against the service.
  router.post("/", asyncHandler(controller.create));

  router.get(
    "/:id",
    validateParams(IntentIdParamSchema),
    validateQuery(IntentOwnerQuerySchema),
    asyncHandler(controller.getById)
  );

  router.post(
    "/:id/awaiting-signature",
    validateParams(IntentIdParamSchema),
    validateBody(MarkAwaitingSignatureBodySchema),
    asyncHandler(controller.markAwaitingSignature)
  );

  router.post(
    "/:id/signature-failure",
    validateParams(IntentIdParamSchema),
    validateBody(RecordSignatureFailureBodySchema),
    asyncHandler(controller.recordSignatureFailure)
  );

  router.post(
    "/:id/signed",
    validateParams(IntentIdParamSchema),
    validateBody(AttachSignedXdrBodySchema),
    asyncHandler(controller.attachSignedXdr)
  );

  router.post(
    "/:id/outcome",
    validateParams(IntentIdParamSchema),
    validateBody(RecordSubmissionOutcomeBodySchema),
    asyncHandler(controller.recordSubmissionOutcome)
  );

  return router;
}
