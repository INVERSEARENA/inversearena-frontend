import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import { ArenaStatsService } from "../services/arenaStatsService";
import { prisma } from "../db/prisma";

export function createArenasRouter(): Router {
  const router = Router();
  const statsService = new ArenaStatsService(prisma);

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

  return router;
}
