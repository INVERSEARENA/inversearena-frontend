import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { publicCache } from "../middleware/cachePolicy";
import { env } from "../config/env";
import type { LandingStatsService } from "../services/landingStatsService";

/**
 * Public landing statistics (#1626).
 *
 * Anonymous, shareable aggregate feed consumed server-side by the landing
 * page's ISR render (frontend/src/app/page.tsx) and by any edge cache in
 * front of the API. The response is identical for every caller, so it carries
 * a shared-cache `Cache-Control` with stale-while-revalidate — the edge keeps
 * serving it while the origin refreshes in the background.
 *
 * `maxAge` is deliberately shorter than the frontend's ISR window (60s): the
 * frontend renders at most once per minute, and the edge absorbs the
 * anonymous fan-out between renders.
 */
function landingStatsCache() {
  return {
    maxAge: Number(env.LANDING_STATS_CACHE_MAX_AGE_SECONDS ?? 30),
    staleWhileRevalidate: Number(env.LANDING_STATS_STALE_WHILE_REVALIDATE_SECONDS ?? 300),
    staleIfError: 3600,
  };
}

export function createStatsRouter(statsService: LandingStatsService): Router {
  const router = Router();

  /**
   * GET /api/stats/landing
   * Aggregate protocol statistics for the marketing landing page.
   */
  router.get(
    "/landing",
    publicCache(landingStatsCache()),
    asyncHandler(async (_req, res) => {
      const stats = await statsService.getLandingStats();
      res.json(stats);
    }),
  );

  return router;
}
