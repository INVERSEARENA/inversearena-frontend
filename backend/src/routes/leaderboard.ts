import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import type { LeaderboardController } from "../controllers/leaderboard.controller";
import type { RequestHandler } from "express";

export function createLeaderboardRouter(
  controller: LeaderboardController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  /**
   * GET /api/leaderboard
   *
   * Protected — requires valid JWT.
   * Cached for 30s — updates after games end.
   *
   * Query params:
   *  - limit  (1–100, default 20)
   *  - cursor (opaque string for next page)
   */
  router.get(
    "/",
    authMiddleware,
    cacheMiddleware(
      (req) =>
        `${cacheKeys.leaderboard()}:${req.query.limit ?? 20}:${req.query.cursor ?? "0"}`,
      cacheTTL.LEADERBOARD,
    ),
    asyncHandler(controller.getLeaderboard),
  );

  return router;
}
