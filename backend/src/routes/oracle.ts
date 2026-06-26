import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cache, cacheKeys, cacheTTL } from "../cache/cacheService";
import { redis } from "../cache/redisClient";
import { verifyWebhookSignature } from "../middleware/verifyWebhook";

const ORACLE_WEBHOOK_SECRET = process.env.ORACLE_WEBHOOK_SECRET;
if (!ORACLE_WEBHOOK_SECRET) {
  throw new Error("ORACLE_WEBHOOK_SECRET environment variable is required");
}

interface YieldData {
  protocol: string;
  currentAPY: number;
  baseRate: number;
  surgeMultiplier: number;
  lastUpdated: string;
  asset: string;
  network: string;
}

const DEFAULT_YIELD: YieldData = {
  protocol: "Ondo USDY",
  currentAPY: 5.25,
  baseRate: 4.8,
  surgeMultiplier: 1.0,
  lastUpdated: new Date().toISOString(),
  asset: "USDY",
  network: "stellar",
};

export function createOracleRouter(): Router {
  const router = Router();

  router.get(
    "/yield",
    cacheMiddleware(() => cacheKeys.oracleYield(), cacheTTL.ORACLE_YIELD),
    asyncHandler(async (_req, res) => {
      const yieldData = await cache.get<YieldData>(cacheKeys.oracleYield());
      res.json(yieldData ?? DEFAULT_YIELD);
    }),
  );

  router.post(
    "/yield",
    verifyWebhookSignature(ORACLE_WEBHOOK_SECRET!),
    asyncHandler(async (req, res) => {
      const { currentAPY, baseRate, surgeMultiplier, protocol, asset } =
        req.body;

      const updatedYield: YieldData = {
        protocol: protocol ?? DEFAULT_YIELD.protocol,
        currentAPY: currentAPY ?? DEFAULT_YIELD.currentAPY,
        baseRate: baseRate ?? DEFAULT_YIELD.baseRate,
        surgeMultiplier: surgeMultiplier ?? DEFAULT_YIELD.surgeMultiplier,
        lastUpdated: new Date().toISOString(),
        asset: asset ?? DEFAULT_YIELD.asset,
        network: DEFAULT_YIELD.network,
      };

      await redis.set(cacheKeys.oracleYield(), JSON.stringify(updatedYield));
      res.status(200).json(updatedYield);
    }),
  );

  return router;
}
