/**
 * Web Push subscription routes (#1571).
 *
 * Subscriptions are bound to the authenticated wallet and stored with
 * AES-256-GCM encrypted keys. Push keys are never returned to clients.
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { NotificationPreferencesService } from "../services/notificationPreferencesService";
import { PushService, PushNotConfiguredError } from "../services/pushService";
import { apiError } from "../utils/apiError";

const SubscriptionBodySchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
  userAgent: z.string().max(512).optional(),
});

const DeleteBodySchema = z.object({
  endpoint: z.string().url().max(2000),
});

export function createPushSubscriptionsRouter(authMiddleware: any): Router {
  const router = Router();
  const prefsService = new NotificationPreferencesService(prisma);
  const pushService = new PushService(prisma, prefsService);

  function toHttpError(error: unknown): never {
    if (error instanceof PushNotConfiguredError) {
      throw apiError(503, "PUSH_NOT_CONFIGURED", error.message);
    }
    if (error instanceof Error) {
      throw apiError(400, "INVALID_SUBSCRIPTION", error.message);
    }
    throw error;
  }

  /**
   * GET /api/users/me/push-subscriptions
   * Lists the wallet's push endpoints (keys are never exposed).
   */
  router.get(
    "/me/push-subscriptions",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }
      const subscriptions = await pushService.listSubscriptions(userId);
      res.json({ items: subscriptions });
    }),
  );

  /**
   * POST /api/users/me/push-subscriptions
   * Creates (or refreshes) a device subscription for the wallet.
   */
  router.post(
    "/me/push-subscriptions",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }
      const body = SubscriptionBodySchema.parse(req.body);
      try {
        const { userAgent, ...rest } = body;
        const subscription = await pushService.createSubscription(
          userId,
          userAgent === undefined ? rest : { ...rest, userAgent },
        );
        res.status(201).json(subscription);
      } catch (error) {
        toHttpError(error);
      }
    }),
  );

  /**
   * DELETE /api/users/me/push-subscriptions
   * Removes one device subscription for the wallet.
   */
  router.delete(
    "/me/push-subscriptions",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }
      const body = DeleteBodySchema.parse(req.body);
      const deleted = await pushService.deleteSubscription(userId, body.endpoint);
      if (!deleted) {
        throw apiError(404, "SUBSCRIPTION_NOT_FOUND", "Push subscription not found");
      }
      res.json({ deleted: true });
    }),
  );

  return router;
}
