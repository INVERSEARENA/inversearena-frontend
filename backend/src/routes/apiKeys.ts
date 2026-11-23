import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { ApiKeyService } from "../services/apiKeyService";
import type { RequestHandler } from "express";
import { apiError } from "../utils/apiError";
import { z } from "zod";

const CreateKeySchema = z.object({
  ownerLabel: z.string().min(1).max(120).optional(),
  scopes: z.array(z.string()).optional(),
  quotaRequests: z.number().int().min(1).max(100000).optional(),
  quotaWindowSeconds: z.number().int().min(1).max(86400).optional(),
  expiresAt: z.string().datetime().optional(),
});

const RevokeKeySchema = z.object({
  keyId: z.string().min(1),
});

/**
 * Self-service and admin-issued API key management (#1737).
 *
 * POST /api/users/me/api-keys   — create a new key (raw key returned once)
 * GET  /api/users/me/api-keys   — list the caller's keys (no raw keys)
 * DELETE /api/users/me/api-keys/:id — revoke a key
 * POST  /api/users/me/api-keys/:id/rotate — rotate a key
 *
 * The owner is derived from the authenticated user's wallet address,
 * so a player can self-manage their own keys without admin involvement.
 * An admin can also create keys on behalf of an integrator by passing
 * the `owner` field (admin route).
 */
export function createApiKeyRouter(
  service: ApiKeyService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // All key management routes require JWT auth
  router.use(authMiddleware);

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const owner = req.user?.walletAddress;
      if (!owner) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const parsed = CreateKeySchema.parse(req.body);
      const result = await service.createKey({
        owner,
        ownerLabel: parsed.ownerLabel,
        scopes: parsed.scopes,
        quotaRequests: parsed.quotaRequests,
        quotaWindowSeconds: parsed.quotaWindowSeconds,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      });

      res.status(201).json(result);
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const owner = req.user?.walletAddress;
      if (!owner) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const keys = await service.listKeys(owner);
      res.json({ keys });
    }),
  );

  router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
      const owner = req.user?.walletAddress;
      if (!owner) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const result = await service.revokeKey(req.params.id, owner);
      res.json(result);
    }),
  );

  router.post(
    "/:id/rotate",
    asyncHandler(async (req, res) => {
      const owner = req.user?.walletAddress;
      if (!owner) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const result = await service.rotateKey(req.params.id, owner);
      res.status(201).json(result);
    }),
  );

  return router;
}
