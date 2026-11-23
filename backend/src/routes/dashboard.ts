/**
 * Dashboard bootstrap routes (#1501).
 *
 * GET /api/dashboard/bootstrap — one wallet-scoped round trip that returns
 * every dashboard section with an independent `ok | unavailable | stale`
 * state, a per-section etag, a signed server-time token, the protocol config
 * revision, and the current ledger sequence.
 *
 * Response caching: the envelope mixes public content (platform/ledger) with
 * wallet-private data, so it is marked `private, no-store` and `Vary:
 * Authorization`. Individual sections carry etags so the client can re-request
 * only what it needs; wallet-private reads are never shared across principals.
 */

import { Router, type RequestHandler } from "express";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { DashboardBootstrapService } from "../services/dashboardBootstrapService";
import { apiError } from "../utils/apiError";

export function createDashboardRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const bootstrapService = new DashboardBootstrapService(prisma);

  /**
   * GET /api/dashboard/bootstrap
   * Requires a valid wallet session. Sections degrade independently — the
   * request still succeeds with `outcome: "partial"` when a dependency is
   * slow or down.
   */
  router.get(
    "/bootstrap",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const payload = await bootstrapService.compose(userId);

      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Authorization");
      res.json(payload);
    }),
  );

  return router;
}
