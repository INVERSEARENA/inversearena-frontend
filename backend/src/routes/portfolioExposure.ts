/**
 * Portfolio Exposure Routes (#1397)
 *
 * Provides portfolio-level exposure summary across active arenas.
 */

import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { PortfolioExposureService } from "../services/portfolioExposureService";
import { apiError } from "../utils/apiError";

export function createPortfolioExposureRouter(authMiddleware: any): Router {
  const router = Router();
  const exposureService = new PortfolioExposureService(prisma);

  /**
   * GET /api/users/me/portfolio
   * Returns portfolio-level exposure summary for the authenticated user.
   */
  router.get(
    "/me/portfolio",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const exposure = await exposureService.getPortfolioExposure(userId);
      res.json(exposure);
    }),
  );

  return router;
}
