/**
 * Notification Preferences Routes (#1396)
 *
 * Manages user notification preferences and delivery ledger.
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { NotificationPreferencesService } from "../services/notificationPreferencesService";
import { apiError } from "../utils/apiError";

const UpdatePreferencesSchema = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  roundNotifications: z.boolean().optional(),
  payoutNotifications: z.boolean().optional(),
  eliminationNotifications: z.boolean().optional(),
  email: z.string().email().optional(),
  pushToken: z.string().optional(),
});

export function createNotificationPreferencesRouter(authMiddleware: any): Router {
  const router = Router();
  const prefsService = new NotificationPreferencesService(prisma);

  /**
   * GET /api/users/me/notifications
   * Returns the authenticated user's notification preferences.
   */
  router.get(
    "/me/notifications",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const preferences = await prefsService.getPreferences(userId);
      res.json(preferences);
    }),
  );

  /**
   * PUT /api/users/me/notifications
   * Updates the authenticated user's notification preferences.
   */
  router.put(
    "/me/notifications",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const updates = UpdatePreferencesSchema.parse(req.body);
      const preferences = await prefsService.updatePreferences(userId, updates);
      res.json(preferences);
    }),
  );

  /**
   * GET /api/users/me/notifications/history
   * Returns the authenticated user's notification delivery history.
   */
  router.get(
    "/me/notifications/history",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      const history = await prefsService.getDeliveryHistory(userId, { limit, offset });
      res.json({ items: history, limit, offset });
    }),
  );

  return router;
}
