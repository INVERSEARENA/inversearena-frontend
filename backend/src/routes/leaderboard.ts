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
   *
   * Cache key design: the key is scoped by pagination params only, NOT by user identity.
   * This is intentional — leaderboard data is public: every player sees the same global
   * rankings. The response must never include personalised fields (e.g. "my rank
   * highlighted"). If personalised fields are added in the future, the cache key MUST be
   * updated to include a user-scoped identifier to prevent cross-user data leakage.
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
