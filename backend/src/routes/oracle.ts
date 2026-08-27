import { Router } from "express";
import { z } from "zod";
import { asyncHandler, validateBody } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cache, cacheKeys, cacheTTL } from "../cache/cacheService";
import { redis } from "../cache/redisClient";
import { verifyWebhookSignature } from "../middleware/verifyWebhook";

interface YieldData {
  protocol: string;
  currentAPY: number;
  baseRate: number;
  surgeMultiplier: number;
  lastUpdated: string;
  asset: string;
  network: string;
}

const YieldUpdateSchema = z.object({
  protocol: z.string().trim().min(1).max(64).optional(),
  currentAPY: z.number().finite().min(0).max(100).optional(),
  baseRate: z.number().finite().min(0).max(100).optional(),
  surgeMultiplier: z.number().finite().min(0).max(10).optional(),
  asset: z.string().trim().min(1).max(16).optional(),
});

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
    asyncHandler(async (req, res, next) => {
      const ORACLE_WEBHOOK_SECRET = process.env.ORACLE_WEBHOOK_SECRET;
      if (!ORACLE_WEBHOOK_SECRET) {
        res.status(503).json({ error: "ORACLE_WEBHOOK_SECRET not configured" });
        return;
      }
      verifyWebhookSignature(ORACLE_WEBHOOK_SECRET)(req, res, next);
    }),
    validateBody(YieldUpdateSchema),
    asyncHandler(async (req, res) => {
      const { currentAPY, baseRate, surgeMultiplier, protocol, asset } =
        req.body as z.infer<typeof YieldUpdateSchema>;

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
