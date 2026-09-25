import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { UsersController } from "../controllers/users.controller";
import type { RequestHandler } from "express";
import { prisma } from "../db/prisma";
import { ActiveStakeLimitsService, MAX_ACTIVE_STAKE_USDC } from "../services/activeStakeLimitsService";
import { AliasService } from "../services/aliasService";
import { createWatchlistRouter } from "./watchlist";
import { apiError } from "../utils/apiError";
import { z } from "zod";

const AliasUpdateSchema = z.object({
  alias: z
    .string()
    .trim()
    .min(3, "Alias must be at least 3 characters")
    .max(32, "Alias must be at most 32 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Alias may only contain letters, numbers, underscores, and hyphens",
    ),
});

export function createUsersRouter(
  controller: UsersController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();
  const stakeService = new ActiveStakeLimitsService(prisma);
  const aliasService = new AliasService(prisma);

  // Protected — requires valid JWT
  router.get("/me", authMiddleware, asyncHandler(controller.me));
  router.get("/me/activity", authMiddleware, asyncHandler(controller.activity));

  // ── Issue #1411 — Active stake limit ────────────────────────────────────────
  /**
   * GET /api/users/me/stake-limit
   * Returns the player's current active stake and the configured limit.
   * The frontend uses this to disable / warn before the JoinArenaModal fires.
   */
  router.get(
    "/me/stake-limit",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const current = await stakeService.getActiveStake(userId);
      res.json({
        currentActiveStake: current,
        limit: MAX_ACTIVE_STAKE_USDC,
        remainingCapacity: Math.max(0, MAX_ACTIVE_STAKE_USDC - current),
        limitExceeded: current >= MAX_ACTIVE_STAKE_USDC,
      });
    }),
  );

  // ── Issue #1414 — Player aliases ────────────────────────────────────────────
  /**
   * PUT /api/users/me/alias
   * Set or update the calling user's public display alias.
   * Uniqueness and profanity checks are enforced by AliasService.
   */
  router.put(
    "/me/alias",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const { alias } = AliasUpdateSchema.parse(req.body);
      const updated = await aliasService.setAlias(userId, alias);
      res.json(updated);
    }),
  );

  /**
   * GET /api/users/me/alias/history
   * Returns the rotation history of the calling user's aliases (newest first).
   * Wallet addresses are never included in the response.
   */
  router.get(
    "/me/alias/history",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const history = await aliasService.getAliasHistory(userId);
      res.json({ history });
    }),
  );

  /**
   * GET /api/users/alias/:alias
   * Public lookup: resolves an alias to its anonymised public profile.
   * Never exposes wallet addresses.
   */
  router.get(
    "/alias/:alias",
    asyncHandler(async (req, res) => {
      const alias = req.params.alias?.trim();
      if (!alias) throw apiError(400, "INVALID_ALIAS", "Alias is required");

      const profile = await aliasService.resolvePublicProfile(alias);
      if (!profile) throw apiError(404, "ALIAS_NOT_FOUND", `Alias '${alias}' not found`);

      res.json(profile);
    }),
  );

  // Issue #1402 — Arena watchlist, mounted from its own module (see
  // routes/watchlist.ts for why: this router already imports
  // ActiveStakeLimitsService, which has a pre-existing broken metrics
  // import unrelated to this change and blocks any test that imports
  // this file).
  router.use(createWatchlistRouter(prisma, authMiddleware));

  return router;
}
