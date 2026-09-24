/**
 * Cancellation Recovery Routes (#1398)
 *
 * Implements cancellation recovery status for every participant.
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { CancellationRecoveryService } from "../services/cancellationRecoveryService";
import { apiError } from "../utils/apiError";

const UpdateRecoverySchema = z.object({
  status: z.enum(["refundable", "submitted", "confirmed", "failed"]),
  refundAmount: z.number().optional(),
  txHash: z.string().optional(),
  failureReason: z.string().optional(),
});

export function createCancellationRecoveryRouter(authMiddleware: any): Router {
  const router = Router();
  const recoveryService = new CancellationRecoveryService(prisma);

  /**
   * GET /api/arenas/:id/recovery
   * Returns cancellation recovery status for an arena.
   */
  router.get(
    "/:id/recovery",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena id is required");
      }

      const recovery = await recoveryService.getArenaRecovery(id);
      if (!recovery) {
        throw apiError(404, "ARENA_NOT_CANCELLED", "Arena is not cancelled or not found");
      }

      res.json(recovery);
    }),
  );

  /**
   * GET /api/users/me/recovery
   * Returns cancellation recovery status for the authenticated user across all arenas.
   */
  router.get(
    "/me/recovery",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const recovery = await recoveryService.getUserRecoveryStatus(userId);
      res.json({ items: recovery });
    }),
  );

  /**
   * PUT /api/arenas/:id/recovery/:userId
   * Updates recovery status for a participant (admin only).
   */
  router.put(
    "/:id/recovery/:userId",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { id, userId } = req.params;
      if (!id || !userId) {
        throw apiError(400, "INVALID_PARAMS", "Arena id and user id are required");
      }

      // Check if user is admin
      const caller = req.user?.walletAddress;
      if (!caller) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      // TODO: Add admin check here

      const updates = UpdateRecoverySchema.parse(req.body);
      await recoveryService.updateRecoveryStatus(id, userId, updates.status, {
        refundAmount: updates.refundAmount,
        txHash: updates.txHash,
        failureReason: updates.failureReason,
      });

      res.json({ success: true });
    }),
  );

  return router;
}
