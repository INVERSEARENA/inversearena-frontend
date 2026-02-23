import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";

export function createOracleRouter(): Router {
  const router = Router();

  /**
   * GET /api/oracle/yield
   * Returns current RWA yield rates.
   * Cached for 60s — yield rates change infrequently.
   */
  router.get(
    "/yield",
    cacheMiddleware(() => cacheKeys.oracleYield(), cacheTTL.ORACLE_YIELD),
    asyncHandler(async (_req, res) => {
      // TODO: Replace with actual oracle/RWA data source
      const yieldData = {
        protocol: "Ondo USDY",
        currentAPY: 5.25,
        baseRate: 4.8,
        surgeMultiplier: 1.0,
        lastUpdated: new Date().toISOString(),
        asset: "USDY",
        network: "stellar",
      };

      res.json(yieldData);
    })
  );

  return router;
}
