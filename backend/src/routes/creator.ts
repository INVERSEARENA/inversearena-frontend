/**
 * backend/src/routes/creator.ts
 *
 * Creator Operations Console Routes (#1509).
 * Provides authenticated ownership-scoped arena listings, preflight checks,
 * and deterministic lifecycle mutations.
 */

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { CreatorService, type CreatorAction } from "../services/creatorService";
import { apiError } from "../utils/apiError";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  status: z.enum(["waiting", "actionable", "blocked", "degraded", "terminal", "all"]).optional(),
});

const PreflightSchema = z.object({
  action: z.enum(["start", "cancel", "retry_confirmation", "settle"]),
});

const ActionSchema = z.object({
  action: z.enum(["start", "cancel", "retry_confirmation", "settle"]),
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export function createCreatorRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const creatorService = new CreatorService(prisma);

  /**
   * GET /api/creator/arenas
   * Lists all arenas owned by the authenticated wallet address with
   * keyset cursor pagination, lifecycle states, health, and allowed actions.
   */
  router.get(
    "/arenas",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const walletAddress = req.user?.id;
      if (!walletAddress) {
        throw apiError(401, "UNAUTHORIZED", "Wallet authentication required");
      }

      const { limit, cursor, status } = QuerySchema.parse(req.query);
      const result = await creatorService.listCreatorArenas(
        walletAddress,
        limit,
        cursor,
        status,
      );

      res.json(result);
    }),
  );

  /**
   * POST /api/creator/arenas/:id/preflight
   * Performs ownership, capability, phase, and network preflight immediately before signing.
   */
  router.post(
    "/arenas/:id/preflight",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const walletAddress = req.user?.id;
      if (!walletAddress) {
        throw apiError(401, "UNAUTHORIZED", "Wallet authentication required");
      }

      const { id } = req.params;
      const { action } = PreflightSchema.parse(req.body);

      const check = await creatorService.preflightAction(
        id,
        walletAddress,
        action as CreatorAction,
      );

      if (!check.valid) {
        res.status(409).json({
          allowed: false,
          reason: check.reason,
        });
        return;
      }

      res.json({
        allowed: true,
        arenaId: id,
        action,
      });
    }),
  );

  /**
   * POST /api/creator/arenas/:id/action
   * Executes a lifecycle action on an arena owned by the caller.
   */
  router.post(
    "/arenas/:id/action",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const walletAddress = req.user?.id;
      if (!walletAddress) {
        throw apiError(401, "UNAUTHORIZED", "Wallet authentication required");
      }

      const { id } = req.params;
      const { action, txHash } = ActionSchema.parse(req.body);

      try {
        const result = await creatorService.executeCreatorAction(
          id,
          walletAddress,
          action as CreatorAction,
          txHash,
        );
        res.json(result);
      } catch (err: any) {
        throw apiError(400, "CREATOR_ACTION_FAILED", err.message || "Action failed");
      }
    }),
  );

  return router;
}
