import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler, validateBody } from "../middleware/validate";
import { cache, cacheKeys } from "../cache/cacheService";
import { verifyWebhookSignature } from "../middleware/verifyWebhook";
import { getKeyring } from "../config/secretKeyring";
import { getOracleFreshnessConfig } from "../config/oracleFreshnessConfig";
import { classifyFreshness, toKeeperStatus, type OracleReading } from "../services/oracleFreshnessService";

interface YieldData {
  protocol: string;
  currentAPY: number;
  baseRate: number;
  surgeMultiplier: number;
  lastUpdated: string;
  asset: string;
  network: string;
}

import { YieldUpdateSchema } from "../validation/requestValidation";

const DEFAULT_YIELD: YieldData = {
  protocol: "Ondo USDY",
  currentAPY: 5.25,
  baseRate: 4.8,
  surgeMultiplier: 1.0,
  lastUpdated: new Date().toISOString(),
  asset: "USDY",
  network: "stellar",
};

/** This webhook-fed feed's schema version — see #1512's OracleReading.sourceVersion. */
const YIELD_FEED_SOURCE_VERSION = 1;

/**
 * Reinterprets a `YieldData.lastUpdated` ISO timestamp as an `OracleReading`
 * so this off-chain, webhook-pushed feed can share the same classification
 * logic (#1512) as the on-chain oracle contract, rather than a second,
 * bespoke staleness implementation.
 */
function toOracleReading(yieldData: YieldData): OracleReading {
  const observedAt = Math.floor(new Date(yieldData.lastUpdated).getTime() / 1000);
  return {
    rateBps: Math.round(yieldData.currentAPY * 100),
    observedAt: Number.isFinite(observedAt) ? observedAt : 0,
    sourceVersion: YIELD_FEED_SOURCE_VERSION,
  };
}

export function createOracleRouter(adminAuthMiddleware: RequestHandler): Router {
  const router = Router();

  router.get(
    "/yield",
    // Not wrapped in cacheMiddleware (#1512): it would key on the same
    // "oracle:yield" entry the handler itself reads/writes and cache the
    // *response* (including freshness/ageSeconds) for cacheTTL.ORACLE_YIELD
    // seconds — silently freezing the age this endpoint exists to report
    // accurately. The underlying read below is already a single indexed
    // Redis GET; there is no expensive computation left to cache.
    asyncHandler(async (_req, res) => {
      const yieldData = (await cache.get<YieldData>(cacheKeys.oracleYield())) ?? DEFAULT_YIELD;
      const config = getOracleFreshnessConfig();
      const classification = classifyFreshness(
        Math.floor(Date.now() / 1000),
        toOracleReading(yieldData),
        config,
      );
      // Additive fields (#1512) — existing consumers reading only the
      // original YieldData shape are unaffected.
      res.json({
        ...yieldData,
        freshness: classification.freshness,
        ageSeconds: classification.ageSeconds,
      });
    }),
  );

  router.post(
    "/yield",
    asyncHandler(async (req, res, next) => {
      // Current + (during rotation) previous key, see config/secretKeyring.
      const keyring = getKeyring("webhook");
      if (!keyring) {
        res.status(503).json({ error: "ORACLE_WEBHOOK_SECRET not configured" });
        return;
      }
      verifyWebhookSignature(keyring)(req, res, next);
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

      // #1512: bounded by the freshness policy's own max age — a pushed
      // value that's never followed by another update now ages out of the
      // cache instead of being served indefinitely under an ever-growing
      // "true" age once it's gone stale (the GET route's classification
      // already marks it stale well before this expiry; this is a backstop,
      // not the primary staleness signal).
      const { maxAgeSeconds } = getOracleFreshnessConfig();
      await cache.set(cacheKeys.oracleYield(), updatedYield, maxAgeSeconds);
      res.status(200).json(updatedYield);
    }),
  );

  /**
   * GET /api/oracle/keeper-status (#1512)
   *
   * Keeper/operator-facing: identifies an overdue oracle update using only
   * the already-cached feed value — never fetches from Ondo/Band/etc.
   * itself. Admin-authenticated, matching this codebase's other
   * operator-only endpoints (e.g. /api/worker, /api/payouts admin actions).
   */
  router.get(
    "/keeper-status",
    adminAuthMiddleware,
    asyncHandler(async (_req, res) => {
      const yieldData = await cache.get<YieldData>(cacheKeys.oracleYield());
      const config = getOracleFreshnessConfig();
      const now = Math.floor(Date.now() / 1000);
      const classification = classifyFreshness(now, yieldData ? toOracleReading(yieldData) : null, config);
      res.json(toKeeperStatus(cacheKeys.oracleYield(), classification, config));
    }),
  );

  return router;
}
