import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";

export function createArenasRouter(): Router {
  const router = Router();

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

      // TODO: Replace with actual DB/contract query
      const stats = {
        arenaId: id,
        currentPot: 25000,
        playerCount: 128,
        survivorCount: 64,
        currentRound: 3,
        entryFee: 100,
        yieldAccrued: 542.5,
        status: "active",
        lastUpdated: new Date().toISOString(),
      };

      res.json(stats);
    })
  );

  return router;
}
