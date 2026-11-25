import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { publicCache } from "../middleware/cachePolicy";
import { apiError } from "../utils/apiError";
import type { PriceService } from "../services/priceService";

const AssetsQuerySchema = z.object({
  assets: z.string().transform((val) => val.split(",").map((s) => s.trim().toUpperCase())),
});

/**
 * Price routes — #1858.
 *
 * GET /api/prices?assets=XLM,USDC
 *   Returns fiat equivalent prices for the requested assets from the on-chain
 *   oracle. Stale prices are returned with { stale: true } and callers should
 *   suppress fiat display in the UI when this is true.
 *
 * GET /api/prices/:asset
 *   Returns price for a single asset.
 */
export function createPricesRouter(priceService: PriceService): Router {
  const router = Router();

  router.get(
    "/",
    publicCache({ maxAge: 60, staleWhileRevalidate: 120 }),
    asyncHandler(async (req, res) => {
      const parsed = AssetsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw apiError(400, "BAD_REQUEST", "assets query parameter is required (comma-separated)");
      }

      const { assets } = parsed.data;
      if (assets.length > 20) {
        throw apiError(400, "BAD_REQUEST", "At most 20 assets per request");
      }

      const results = await Promise.all(
        assets.map(async (assetCode) => {
          const price = await priceService.getPrice(assetCode);
          if (!price) return { assetCode, available: false };
          return {
            assetCode,
            available: true,
            priceUsd: price.stale ? null : price.priceUsd,
            stale: price.stale,
            computedAt: price.computedAt,
          };
        }),
      );

      const computedAt = new Date().toISOString();
      res.json({ prices: results, computedAt });
    }),
  );

  router.get(
    "/:asset",
    publicCache({ maxAge: 60, staleWhileRevalidate: 120 }),
    asyncHandler(async (req, res) => {
      const assetCode = req.params.asset?.toUpperCase();
      if (!assetCode || !/^[A-Z0-9]{1,12}$/.test(assetCode)) {
        throw apiError(400, "BAD_REQUEST", "Invalid asset code");
      }

      const price = await priceService.getPrice(assetCode);
      if (!price) {
        throw apiError(404, "NOT_FOUND", `No price data for ${assetCode}`);
      }

      res.json({
        assetCode,
        priceUsd: price.stale ? null : price.priceUsd,
        stale: price.stale,
        computedAt: price.computedAt,
      });
    }),
  );

  return router;
}
