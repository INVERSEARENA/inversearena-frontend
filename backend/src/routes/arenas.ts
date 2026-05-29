import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import { ArenaStatsService } from "../services/arenaStatsService";
import { ArenaController } from "../controllers/arena.controller";
import { prisma } from "../db/prisma";

export function createArenasRouter(): Router {
  const router = Router();
  const statsService = new ArenaStatsService(prisma);
  const arenaController = new ArenaController(prisma);

  /**
   * GET /api/arenas/:id/stats
   * Returns stats for a specific arena.
   * Cached for 15s — arena state changes with game rounds.
   */
  router.get(
    "/:id/stats",
    cacheMiddleware((req) => cacheKeys.arenaStats(req.params.id), cacheTTL.ARENA_STATS),
    asyncHandler(async (req, res) => {
      const { id } = req.params;

      try {
        const stats = await statsService.getArenaStats(id);
        res.json(stats);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          res.status(404).json({ error: error.message });
        } else {
          throw error;
        }
      }
    })
  );

  /**
   * GET /api/arenas/:id/participants
   * Returns paginated list of participants in a specific arena.
   * Cached for 5s — participant status changes with round eliminations.
   */
  router.get(
    "/:id/participants",
    cacheMiddleware(
      (req) => `arena:participants:${req.params.id}:${req.query.limit || 25}:${req.query.cursor || ""}`,
      5
    ),
    asyncHandler(arenaController.getParticipants)
  );

  return router;
}
