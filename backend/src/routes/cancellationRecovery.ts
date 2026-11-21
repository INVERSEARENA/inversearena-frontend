/**
 * Cancellation Recovery Routes (#1398)
 *
 * Implements cancellation recovery status for every participant.
 */

import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { CancellationRecoveryService } from "../services/cancellationRecoveryService";
import { apiError } from "../utils/apiError";

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

  return router;
}
