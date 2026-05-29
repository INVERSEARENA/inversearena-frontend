import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import { verifyWebhookSignature } from "../middleware/verifyWebhook";

const ORACLE_WEBHOOK_SECRET = process.env.ORACLE_WEBHOOK_SECRET;
if (!ORACLE_WEBHOOK_SECRET) {
  throw new Error("ORACLE_WEBHOOK_SECRET environment variable is required");
}

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

  /**
   * POST /api/oracle/yield
   * Updates RWA yield rates via oracle webhook callback.
   * Requires HMAC-SHA256 signature in X-Oracle-Signature header.
   */
  router.post(
    "/yield",
    verifyWebhookSignature(ORACLE_WEBHOOK_SECRET),
    asyncHandler(async (req, res) => {
      const { currentAPY, baseRate, surgeMultiplier, protocol, asset } =
        req.body;

      const updatedYield = {
        protocol: protocol ?? "Ondo USDY",
        currentAPY: currentAPY ?? 5.25,
        baseRate: baseRate ?? 4.8,
        surgeMultiplier: surgeMultiplier ?? 1.0,
        lastUpdated: new Date().toISOString(),
        asset: asset ?? "USDY",
        network: "stellar",
      };

      res.status(200).json(updatedYield);
    })
  );

  return router;
}
