import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";

export function createLeaderboardRouter(): Router {
  const router = Router();

  /**
   * GET /api/leaderboard
   * Returns top-ranked players.
   * Cached for 30s — updates after games end.
   */
  router.get(
    "/",
    cacheMiddleware(() => cacheKeys.leaderboard(), cacheTTL.LEADERBOARD),
    asyncHandler(async (_req, res) => {
      // TODO: Replace with actual DB query
      const leaderboard = {
        players: [
          { rank: 1, address: "GABCD...XYZ", survivalStreak: 12, totalYield: 4250.0, arenasWon: 8 },
          { rank: 2, address: "GEFGH...UVW", survivalStreak: 10, totalYield: 3800.5, arenasWon: 6 },
          { rank: 3, address: "GIJKL...RST", survivalStreak: 9, totalYield: 3200.0, arenasWon: 5 },
        ],
        totalPlayers: 1024,
        lastUpdated: new Date().toISOString(),
      };

      res.json(leaderboard);
    })
  );

  return router;
}
