import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { publicCache } from "../middleware/cachePolicy";
import type { StatusAggregatorService } from "../services/statusAggregatorService";

/**
 * Public, unauthenticated system status page endpoint (#1738).
 *
 * GET /api/status returns a JSON aggregation of all component health
 * signals suitable for rendering a public status page. The response is
 * edge-cacheable (30s max-age, 5m stale-while-revalidate) so the status
 * page remains available even when the API is partially degraded.
 *
 * The endpoint is deliberately separate from /health and /ready:
 *   - /health    : liveness probe (is the process up?)
 *   - /ready     : readiness probe (are dependencies connected?)
 *   - /api/status: public-facing component health with history and
 *                  maintenance context, for players and integrators.
 */
export function createStatusRouter(service: StatusAggregatorService): Router {
  const router = Router();

  router.get(
    "/status",
    // Public and identical for every caller. Edge-cacheable so a status
    // page request does not stampede the origin. The short max-age keeps
    // transitions timely while stale-while-revalidate smooths over spikes.
    publicCache({ maxAge: 30, staleWhileRevalidate: 300, staleIfError: 600 }),
    asyncHandler(async (_req, res) => {
      const status = await service.getSystemStatus();
      res.json(status);
    }),
  );

  return router;
}
