/**
 * Round Outcome Proof Bundle Routes (#1394)
 *
 * Publishes the round outcome proof bundle so a client can independently
 * recompute survivor membership instead of trusting the backend's own
 * verdict. See `docs/round-outcome-proof-bundle.md` for the design note.
 */

import { Router, type RequestHandler } from "express";
import { prisma } from "../db/prisma";
import {
  RoundProofBundleService,
  RoundNotResolvedError,
  RoundProofBundleUnavailableError,
} from "../services/roundProofBundleService";
import { apiError } from "../utils/apiError";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";

export function createRoundProofBundleRouter(
  authMiddleware: RequestHandler,
  proofBundleService: RoundProofBundleService = new RoundProofBundleService(prisma),
): Router {
  const router = Router();

  /**
   * GET /api/rounds/:id/proof-bundle
   *
   * Returns the round outcome proof bundle for a resolved round. A resolved
   * round's bundle is immutable (same input, same output — see
   * RoundProofBundleService.getProofBundle's idempotency note), so it is
   * safe to cache briefly to absorb repeated client-side verification
   * requests without re-deriving the tally on every call.
   */
  router.get(
    "/:id/proof-bundle",
    authMiddleware,
    cacheMiddleware(
      (req) => cacheKeys.roundProofBundle(req.params.id ?? ""),
      cacheTTL.ROUND_PROOF_BUNDLE,
    ),
    async (req, res, next) => {
      const { id } = req.params;
      if (!id) {
        next(apiError(400, "ROUND_ID_REQUIRED", "Round ID is required"));
        return;
      }

      try {
        const bundle = await proofBundleService.getProofBundle(id);
        res.json({ success: true, data: bundle });
      } catch (error) {
        if (error instanceof RoundNotResolvedError) {
          next(apiError(409, "ROUND_NOT_RESOLVED", error.message));
          return;
        }
        if (error instanceof RoundProofBundleUnavailableError) {
          next(apiError(409, "ROUND_PROOF_BUNDLE_UNAVAILABLE", error.message));
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to assemble proof bundle";
        const status = message.includes("not found") ? 404 : 500;
        const code = status === 404 ? "ROUND_NOT_FOUND" : "PROOF_BUNDLE_ASSEMBLY_FAILED";
        next(apiError(status, code, message));
      }
    },
  );

  return router;
}
