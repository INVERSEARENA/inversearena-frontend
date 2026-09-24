import { Router } from "express";
import type { RequestHandler } from "express";
import { asyncHandler, validateBody, validateParams } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { auditLogMiddleware } from "../middleware/auditLog";
import type { PayoutsController } from "../controllers/payouts.controller";
import type { AuthService } from "../services/authService";
import { SignPayoutBodySchema, TransactionIdParamSchema } from "../validation/requestValidation";
// Issue #1413 — fee sponsorship
import { feeSponsorshipService, FEE_SPONSORSHIP_ENABLED, EligibilityConsumedError, EligibilityExpiredError, EligibilityNotFoundError } from "../services/feeSponsorshipService";
import { apiError } from "../utils/apiError";
import { z } from "zod";

const IssueEligibilityBodySchema = z.object({
  payoutId: z.string().trim().min(1).max(128),
  winnerId: z.string().trim().min(1).max(128),
});

export function createPayoutsRouter(
  controller: PayoutsController,
  authService: AuthService,
  adminAuthMiddleware: RequestHandler
): Router {
  const router = Router();

  router.use(auditLogMiddleware());

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

  // ── Issue #1413 — Fee sponsorship eligibility ───────────────────────────────

  /**
   * POST /api/payouts/eligibility
   * Admin-only. Issues a one-time fee sponsorship eligibility token for a winner.
   * Idempotent: calling twice with the same (payoutId, winnerId) returns the
   * same token.
   */
  router.post(
    "/eligibility",
    adminAuthMiddleware,
    asyncHandler(async (req, res) => {
      if (!FEE_SPONSORSHIP_ENABLED) {
        throw apiError(503, "SPONSORSHIP_DISABLED", "Fee sponsorship is not enabled on this deployment");
      }

      const { payoutId, winnerId } = IssueEligibilityBodySchema.parse(req.body);
      const token = feeSponsorshipService.issueEligibility(payoutId, winnerId);
      res.status(201).json(token);
    }),
  );

  /**
   * POST /api/payouts/eligibility/:tokenId/consume
   * Admin-only. Atomically consumes a fee eligibility token.
   * A token can only be consumed once; subsequent calls return 409.
   */
  router.post(
    "/eligibility/:tokenId/consume",
    adminAuthMiddleware,
    asyncHandler(async (req, res) => {
      if (!FEE_SPONSORSHIP_ENABLED) {
        throw apiError(503, "SPONSORSHIP_DISABLED", "Fee sponsorship is not enabled on this deployment");
      }

      const tokenId = req.params.tokenId;
      if (!tokenId) throw apiError(400, "INVALID_TOKEN_ID", "tokenId is required");

      try {
        const consumed = feeSponsorshipService.consumeEligibility(tokenId);
        res.json(consumed);
      } catch (err) {
        if (err instanceof EligibilityConsumedError) {
          throw apiError(409, err.code, err.message);
        }
        if (err instanceof EligibilityExpiredError) {
          throw apiError(409, err.code, err.message);
        }
        if (err instanceof EligibilityNotFoundError) {
          throw apiError(404, err.code, err.message);
        }
        throw err;
      }
    }),
  );

  /**
   * GET /api/payouts/eligibility/:tokenId
   * Authenticated. Read-only status of an eligibility token (for the winner's
   * dashboard to display sponsorship status).
   */
  router.get(
    "/eligibility/:tokenId",
    requireAuth(authService),
    asyncHandler(async (req, res) => {
      if (!FEE_SPONSORSHIP_ENABLED) {
        throw apiError(503, "SPONSORSHIP_DISABLED", "Fee sponsorship is not enabled on this deployment");
      }

      const tokenId = req.params.tokenId;
      if (!tokenId) throw apiError(400, "INVALID_TOKEN_ID", "tokenId is required");

      const token = feeSponsorshipService.getEligibility(tokenId);
      if (!token) throw apiError(404, "ELIGIBILITY_NOT_FOUND", `Token ${tokenId} not found`);

      res.json(token);
    }),
  );

  /**
   * GET /api/payouts/eligibility/winner/:winnerId
   * Authenticated (winner can only see their own). Lists pending eligibility
   * tokens for the requesting winner.
   */
  router.get(
    "/eligibility/winner/:winnerId",
    requireAuth(authService),
    asyncHandler(async (req, res) => {
      if (!FEE_SPONSORSHIP_ENABLED) {
        throw apiError(503, "SPONSORSHIP_DISABLED", "Fee sponsorship is not enabled on this deployment");
      }

      const winnerId = req.params.winnerId;
      if (!winnerId) throw apiError(400, "INVALID_WINNER_ID", "winnerId is required");

      // Users may only list their own tokens.
      if (req.user?.id !== winnerId && !req.adminId) {
        throw apiError(403, "FORBIDDEN", "You may only list your own eligibility tokens");
      }

      const tokens = feeSponsorshipService.listPendingForWinner(winnerId);
      res.json({ tokens });
    }),
  );

  return router;
}
