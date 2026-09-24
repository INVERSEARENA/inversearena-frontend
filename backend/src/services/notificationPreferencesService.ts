/**
 * Notification Preferences Service (#1396)
 *
 * Manages user notification preferences and delivery ledger.
 * Ensures round and payout notices honor per-channel opt-in and deduplicate delivery.
 */

import { PrismaClient, type NotificationPreference, type NotificationDelivery } from "@prisma/client";

export interface NotificationPreferences {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  inAppEnabled: boolean;
  roundNotifications: boolean;
  payoutNotifications: boolean;
  eliminationNotifications: boolean;
  email?: string;
  pushToken?: string;
}

export interface DeliveryRecord {
  id: string;
  userId: string;
  type: "round" | "payout" | "elimination";
  channel: "email" | "push" | "in_app";
  status: "pending" | "sent" | "delivered" | "failed";
  dedupeKey: string;
  createdAt: Date;
  sentAt?: Date;
  error?: string;
}

export class NotificationPreferencesService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get user's notification preferences.
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const prefs = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });

    if (!prefs) {
      // Return default preferences
      return {
        userId,
        emailEnabled: false,
        pushEnabled: false,
        inAppEnabled: true,
        roundNotifications: true,
        payoutNotifications: true,
        eliminationNotifications: true,
      };
    }

    return {
      userId: prefs.userId,
      emailEnabled: prefs.emailEnabled,
      pushEnabled: prefs.pushEnabled,
      inAppEnabled: prefs.inAppEnabled,
      roundNotifications: prefs.roundNotifications,
      payoutNotifications: prefs.payoutNotifications,
      eliminationNotifications: prefs.eliminationNotifications,
      email: prefs.email ?? undefined,
      pushToken: prefs.pushToken ?? undefined,
    };
  }

  /**
   * Update user's notification preferences.
   */
  async updatePreferences(
    userId: string,
    updates: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const prefs = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        emailEnabled: updates.emailEnabled ?? false,
        pushEnabled: updates.pushEnabled ?? false,
        inAppEnabled: updates.inAppEnabled ?? true,
        roundNotifications: updates.roundNotifications ?? true,
        payoutNotifications: updates.payoutNotifications ?? true,
        eliminationNotifications: updates.eliminationNotifications ?? true,
        email: updates.email,
        pushToken: updates.pushToken,
      },
      update: {
        ...(updates.emailEnabled !== undefined && { emailEnabled: updates.emailEnabled }),
        ...(updates.pushEnabled !== undefined && { pushEnabled: updates.pushEnabled }),
        ...(updates.inAppEnabled !== undefined && { inAppEnabled: updates.inAppEnabled }),
        ...(updates.roundNotifications !== undefined && { roundNotifications: updates.roundNotifications }),
        ...(updates.payoutNotifications !== undefined && { payoutNotifications: updates.payoutNotifications }),
        ...(updates.eliminationNotifications !== undefined && { eliminationNotifications: updates.eliminationNotifications }),
        ...(updates.email !== undefined && { email: updates.email }),
        ...(updates.pushToken !== undefined && { pushToken: updates.pushToken }),
      },
    });

    return {
      userId: prefs.userId,
      emailEnabled: prefs.emailEnabled,
      pushEnabled: prefs.pushEnabled,
      inAppEnabled: prefs.inAppEnabled,
      roundNotifications: prefs.roundNotifications,
      payoutNotifications: prefs.payoutNotifications,
      eliminationNotifications: prefs.eliminationNotifications,
      email: prefs.email ?? undefined,
      pushToken: prefs.pushToken ?? undefined,
    };
  }

  /**
   * Check if a notification should be sent based on user preferences.
   */
  async shouldNotify(
    userId: string,
    type: "round" | "payout" | "elimination",
    channel: "email" | "push" | "in_app",
  ): Promise<boolean> {
    const prefs = await this.getPreferences(userId);

    // Check channel enabled
    if (channel === "email" && !prefs.emailEnabled) return false;
    if (channel === "push" && !prefs.pushEnabled) return false;
    if (channel === "in_app" && !prefs.inAppEnabled) return false;

    // Check notification type enabled
    if (type === "round" && !prefs.roundNotifications) return false;
    if (type === "payout" && !prefs.payoutNotifications) return false;
    if (type === "elimination" && !prefs.eliminationNotifications) return false;

    return true;
  }

  /**
   * Record a notification delivery attempt.
   * Returns the delivery record ID for tracking.
   */
  async recordDelivery(
    userId: string,
    type: "round" | "payout" | "elimination",
    channel: "email" | "push" | "in_app",
    dedupeKey: string,
  ): Promise<string> {
    // Check for duplicate delivery
    const existing = await this.prisma.notificationDelivery.findFirst({
      where: {
        userId,
        dedupeKey,
        channel,
        status: { in: ["sent", "delivered"] },
      },
    });

    if (existing) {
      // Already delivered, return existing ID
      return existing.id;
    }

    // Create new delivery record
    const delivery = await this.prisma.notificationDelivery.create({
      data: {
        userId,
        type,
        channel,
        dedupeKey,
        status: "pending",
      },
    });

    return delivery.id;
  }

  /**
   * Mark a delivery as sent.
   */
  async markSent(deliveryId: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "sent",
        sentAt: new Date(),
      },
    });
  }

  /**
   * Mark a delivery as failed.
   */
  async markFailed(deliveryId: string, error: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "failed",
        error,
      },
    });
  }

  /**
   * Get delivery history for a user.
   */
  async getDeliveryHistory(
    userId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<DeliveryRecord[]> {
    const { limit = 50, offset = 0 } = options;

    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    return deliveries.map((d) => ({
      id: d.id,
      userId: d.userId,
      type: d.type as "round" | "payout" | "elimination",
      channel: d.channel as "email" | "push" | "in_app",
      status: d.status as "pending" | "sent" | "delivered" | "failed",
      dedupeKey: d.dedupeKey,
      createdAt: d.createdAt,
      sentAt: d.sentAt ?? undefined,
      error: d.error ?? undefined,
    }));
  }
}
