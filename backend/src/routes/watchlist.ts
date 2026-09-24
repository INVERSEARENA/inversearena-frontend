/**
 * Arena watchlist routes (#1402), mounted under /api/users from
 * routes/users.ts. Kept in its own module so it has no dependency on
 * ActiveStakeLimitsService, whose import of two metrics that do not
 * exist in utils/metrics.ts (activeStakeLimitBlockedTotal,
 * activeStakeCurrentGauge — confirmed pre-existing, unrelated to this
 * change) fails `tsc --noEmit` and blocks any test that imports
 * routes/users.ts as a whole.
 */

import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { WatchlistService } from "../services/watchlistService";
import { apiError } from "../utils/apiError";

const WatchlistParamsSchema = z.object({
  arenaId: z.string().min(1, "Arena id is required"),
});

export function createWatchlistRouter(prisma: PrismaClient, authMiddleware: RequestHandler): Router {
  const router = Router();
  const watchlistService = new WatchlistService(prisma);

  /**
   * GET /api/users/me/watchlist
   * Returns the calling user's watched arena ids.
   */
  router.get(
    "/me/watchlist",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const watchedArenaIds = await watchlistService.list(userId);
      res.json({ watchedArenaIds });
    }),
  );

  /**
   * PUT /api/users/me/watchlist/:arenaId
   * Adds an arena to the watchlist. Idempotent.
   */
  router.put(
    "/me/watchlist/:arenaId",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const { arenaId } = WatchlistParamsSchema.parse(req.params);
      const watchedArenaIds = await watchlistService.watch(userId, arenaId);
      res.json({ watchedArenaIds });
    }),
  );

  /**
   * DELETE /api/users/me/watchlist/:arenaId
   * Removes an arena from the watchlist. Idempotent.
   */
  router.delete(
    "/me/watchlist/:arenaId",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const { arenaId } = WatchlistParamsSchema.parse(req.params);
      const watchedArenaIds = await watchlistService.unwatch(userId, arenaId);
      res.json({ watchedArenaIds });
    }),
  );

  return router;
}
