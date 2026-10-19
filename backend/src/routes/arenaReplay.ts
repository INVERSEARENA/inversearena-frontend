/**
 * Arena Replay Routes (#1395)
 *
 * Provides historical arena replay API with stable event ordering.
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { ArenaReplayService } from "../services/arenaReplayService";
import { apiError } from "../utils/apiError";

const ReplayQuerySchema = z.object({
  fromLedger: z.coerce.number().int().min(0).optional(),
  toLedger: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export function createArenaReplayRouter(authMiddleware: any): Router {
  const router = Router();
  const replayService = new ArenaReplayService(prisma);

  /**
   * GET /api/arenas/:id/replay
   * Returns ordered replay events for an arena within a ledger range.
   * The same ledger range always returns the same ordered replay.
   */
  router.get(
    "/:id/replay",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena id is required");
      }

      const query = ReplayQuerySchema.parse(req.query);

      // Verify arena exists
      const arena = await prisma.arena.findUnique({ where: { id } });
      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${id} not found`);
      }

      const result = await replayService.getReplay(id, query);

      res.json(result);
    }),
  );

  return router;
}
