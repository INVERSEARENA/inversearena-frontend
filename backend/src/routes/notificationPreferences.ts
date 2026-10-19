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
import { STRING_LIMITS, boundedString } from "../validation/payloadLimits";

const UpdatePreferencesSchema = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  roundNotifications: z.boolean().optional(),
  payoutNotifications: z.boolean().optional(),
  eliminationNotifications: z.boolean().optional(),
  email: z.string().max(STRING_LIMITS.email).email().optional(),
  pushToken: boundedString(STRING_LIMITS.pushToken).optional(),
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

  /**
   * GET /api/users/me/notifications/inbox
   * Returns the authenticated user's in-app notification inbox with acknowledgement support (#1513).
   * Supports filtering by read/unread status and pagination.
   */
  router.get(
    "/me/notifications/inbox",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const unreadOnly = req.query.unreadOnly === "true";

      const notifications = await prefsService.getInboxNotifications(userId, {
        limit,
        offset,
        unreadOnly,
      });

      res.json(notifications);
    }),
  );

  /**
   * POST /api/users/me/notifications/inbox/:notificationId/acknowledge
   * Mark a notification as read with acknowledgement semantics (#1513).
   */
  router.post(
    "/me/notifications/inbox/:notificationId/acknowledge",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const notificationId = req.params.notificationId;
      if (!notificationId) {
        throw apiError(400, "INVALID_NOTIFICATION_ID", "Notification ID is required");
      }

      const acknowledged = await prefsService.acknowledgeNotification(userId, notificationId);
      if (!acknowledged) {
        throw apiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
      }

      res.json({ success: true, notificationId });
    }),
  );

  return router;
}
