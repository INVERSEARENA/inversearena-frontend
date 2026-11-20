/**
 * Notification Preferences Service (#1396)
 *
 * Manages user notification preferences and delivery ledger.
 * Ensures round and payout notices honor per-channel opt-in and deduplicate delivery.
 */

import { PrismaClient, type NotificationPreference, type NotificationDelivery } from "@prisma/client";

export type DeliveryType =
  | "round"
  | "payout"
  | "elimination"
  | "rematch"
  | "arena_announcement";
export type DeliveryChannel =
  | "email"
  | "push"
  | "in_app"
  | "telegram"
  | "discord"
  | "webhook";
export type DeliveryStatus = "pending" | "retrying" | "sent" | "delivered" | "failed" | "dead_letter";

export interface NotificationPreferences {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  telegramEnabled: boolean;
  discordEnabled: boolean;
  inAppEnabled: boolean;
  roundNotifications: boolean;
  payoutNotifications: boolean;
  eliminationNotifications: boolean;
  arenaAnnouncementNotifications: boolean;
  email?: string;
  pushToken?: string;
}

export interface ChannelPreference {
  eventType: DeliveryType;
  channel: DeliveryChannel;
  enabled: boolean;
}

export interface DeliveryContext {
  arenaId?: string;
  message?: { title: string; body: string; url: string; tag?: string };
  [key: string]: unknown;
}

export interface DeliveryRecord {
  id: string;
  userId: string;
  type: DeliveryType;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  dedupeKey: string;
  createdAt: Date;
  sentAt?: Date;
  error?: string;
  attempts: number;
  nextAttemptAt?: Date;
  deadLetteredAt?: Date;
  lastError?: string;
  context?: DeliveryContext;
}

export interface DueDelivery extends DeliveryRecord {
  context: DeliveryContext;
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
        telegramEnabled: false,
        discordEnabled: false,
        inAppEnabled: true,
        roundNotifications: true,
        payoutNotifications: true,
        eliminationNotifications: true,
        arenaAnnouncementNotifications: true,
      };
    }

    return {
      userId: prefs.userId,
      emailEnabled: prefs.emailEnabled,
      pushEnabled: prefs.pushEnabled,
      telegramEnabled: prefs.telegramEnabled,
      discordEnabled: prefs.discordEnabled,
      inAppEnabled: prefs.inAppEnabled,
      roundNotifications: prefs.roundNotifications,
      payoutNotifications: prefs.payoutNotifications,
      eliminationNotifications: prefs.eliminationNotifications,
      arenaAnnouncementNotifications: prefs.arenaAnnouncementNotifications,
      ...(prefs.email != null ? { email: prefs.email } : {}),
      ...(prefs.pushToken != null ? { pushToken: prefs.pushToken } : {}),
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
        telegramEnabled: updates.telegramEnabled ?? false,
        discordEnabled: updates.discordEnabled ?? false,
        inAppEnabled: updates.inAppEnabled ?? true,
        roundNotifications: updates.roundNotifications ?? true,
        payoutNotifications: updates.payoutNotifications ?? true,
        eliminationNotifications: updates.eliminationNotifications ?? true,
        arenaAnnouncementNotifications: updates.arenaAnnouncementNotifications ?? true,
        ...(updates.email !== undefined ? { email: updates.email } : {}),
        ...(updates.pushToken !== undefined ? { pushToken: updates.pushToken } : {}),
      },
      update: {
        ...(updates.emailEnabled !== undefined && { emailEnabled: updates.emailEnabled }),
        ...(updates.pushEnabled !== undefined && { pushEnabled: updates.pushEnabled }),
        ...(updates.telegramEnabled !== undefined && { telegramEnabled: updates.telegramEnabled }),
        ...(updates.discordEnabled !== undefined && { discordEnabled: updates.discordEnabled }),
        ...(updates.inAppEnabled !== undefined && { inAppEnabled: updates.inAppEnabled }),
        ...(updates.roundNotifications !== undefined && { roundNotifications: updates.roundNotifications }),
        ...(updates.payoutNotifications !== undefined && { payoutNotifications: updates.payoutNotifications }),
        ...(updates.eliminationNotifications !== undefined && { eliminationNotifications: updates.eliminationNotifications }),
        ...(updates.arenaAnnouncementNotifications !== undefined && {
          arenaAnnouncementNotifications: updates.arenaAnnouncementNotifications,
        }),
        ...(updates.email !== undefined ? { email: updates.email } : {}),
        ...(updates.pushToken !== undefined ? { pushToken: updates.pushToken } : {}),
      },
    });

    return {
      userId: prefs.userId,
      emailEnabled: prefs.emailEnabled,
      pushEnabled: prefs.pushEnabled,
      telegramEnabled: prefs.telegramEnabled,
      discordEnabled: prefs.discordEnabled,
      inAppEnabled: prefs.inAppEnabled,
      roundNotifications: prefs.roundNotifications,
      payoutNotifications: prefs.payoutNotifications,
      eliminationNotifications: prefs.eliminationNotifications,
      arenaAnnouncementNotifications: prefs.arenaAnnouncementNotifications,
      ...(prefs.email != null ? { email: prefs.email } : {}),
      ...(prefs.pushToken != null ? { pushToken: prefs.pushToken } : {}),
    };
  }

  /**
   * Check if a notification should be sent based on user preferences.
   */
  async shouldNotify(
    userId: string,
    type: DeliveryType,
    channel: DeliveryChannel,
  ): Promise<boolean> {
    const prefs = await this.getPreferences(userId);

    // Check channel enabled. Webhooks are configured by hosts rather than
    // opted into per wallet, so they only depend on the event switch.
    if (channel === "email" && !prefs.emailEnabled) return false;
    if (channel === "push" && !prefs.pushEnabled) return false;
    if (channel === "telegram" && !prefs.telegramEnabled) return false;
    if (channel === "discord" && !prefs.discordEnabled) return false;
    if (channel === "in_app" && !prefs.inAppEnabled) return false;

    // Check notification type enabled
    if (type === "round" && !prefs.roundNotifications) return false;
    if (type === "payout" && !prefs.payoutNotifications) return false;
    if (type === "elimination" && !prefs.eliminationNotifications) return false;
    // A rematch is a fresh round invitation (#1572); it honours the same
    // round-notification opt-in rather than introducing a new preference.
    if (type === "rematch" && !prefs.roundNotifications) return false;
    if (type === "arena_announcement" && !prefs.arenaAnnouncementNotifications) return false;

    return true;
  }

  /**
   * Resolve a per-(event, channel) opt-in, falling back to the legacy channel
   * and event switches when no explicit row exists (#1735).
   */
  async isChannelEventEnabled(
    userId: string,
    eventType: DeliveryType,
    channel: DeliveryChannel,
  ): Promise<boolean> {
    const explicit = await this.prisma.notificationChannelPreference.findUnique({
      where: { userId_eventType_channel: { userId, eventType, channel } },
      select: { enabled: true },
    });
    if (explicit) return explicit.enabled;
    return this.shouldNotify(userId, eventType, channel);
  }

  async getChannelPreferences(userId: string): Promise<ChannelPreference[]> {
    const rows = await this.prisma.notificationChannelPreference.findMany({
      where: { userId },
      select: { eventType: true, channel: true, enabled: true },
      orderBy: [{ eventType: "asc" }, { channel: "asc" }],
    });
    return rows.map((row) => ({
      eventType: row.eventType as DeliveryType,
      channel: row.channel as DeliveryChannel,
      enabled: row.enabled,
    }));
  }

  async updateChannelPreferences(
    userId: string,
    updates: ChannelPreference[],
  ): Promise<ChannelPreference[]> {
    for (const update of updates) {
      await this.prisma.notificationChannelPreference.upsert({
        where: {
          userId_eventType_channel: {
            userId,
            eventType: update.eventType,
            channel: update.channel,
          },
        },
        create: {
          userId,
          eventType: update.eventType,
          channel: update.channel,
          enabled: update.enabled,
        },
        update: { enabled: update.enabled },
      });
    }
    return this.getChannelPreferences(userId);
  }

  /**
   * True when a delivery for this dedupe key already reached the user on
   * this channel (#1571). Used by every channel adapter to fan out at most
   * once per (user, arena, round, type, channel).
   */
  async hasDelivered(userId: string, dedupeKey: string, channel: DeliveryChannel): Promise<boolean> {
    const existing = await this.prisma.notificationDelivery.findFirst({
      where: {
        userId,
        dedupeKey,
        channel,
        status: { in: ["sent", "delivered"] },
      },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * Record a notification delivery attempt.
   * Returns the delivery record ID for tracking. In-flight/dead-lettered
   * records are reused so a retried event cannot spawn duplicate work.
   */
  async recordDelivery(
    userId: string,
    type: DeliveryType,
    channel: DeliveryChannel,
    dedupeKey: string,
    context?: DeliveryContext,
  ): Promise<string> {
    const existing = await this.prisma.notificationDelivery.findFirst({
      where: {
        userId,
        dedupeKey,
        channel,
        status: { in: ["sent", "delivered", "pending", "retrying", "dead_letter"] },
      },
    });

    if (existing) {
      return existing.id;
    }

    const delivery = await this.prisma.notificationDelivery.create({
      data: {
        userId,
        type,
        channel,
        dedupeKey,
        status: "pending",
        ...(context ? { context: context as any } : {}),
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
        deadLetteredAt: null,
        nextAttemptAt: null,
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
        lastError: error,
      },
    });
  }

  /** Queue a retry with exponential backoff (#1735). */
  async markRetrying(
    deliveryId: string,
    attempts: number,
    nextAttemptAt: Date,
    error: string,
  ): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "retrying",
        attempts,
        nextAttemptAt,
        error,
        lastError: error,
      },
    });
  }

  /** Terminal state after the retry budget is exhausted. */
  async markDeadLettered(deliveryId: string, attempts: number, error: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "dead_letter",
        attempts,
        deadLetteredAt: new Date(),
        nextAttemptAt: null,
        error,
        lastError: error,
      },
    });
  }

  /** Deliveries whose backoff window has elapsed and are ready to replay. */
  async getDueRetries(limit = 100): Promise<DueDelivery[]> {
    const rows = await this.prisma.notificationDelivery.findMany({
      where: {
        status: "retrying",
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { nextAttemptAt: "asc" },
      take: limit,
    });
    return rows
      .filter((row) => row.context != null)
      .map((row) => this.toDeliveryRecord(row) as DueDelivery);
  }

  async deleteDelivery(deliveryId: string): Promise<void> {
    await this.prisma.notificationDelivery.delete({ where: { id: deliveryId } }).catch(() => {});
  }

  private toDeliveryRecord(d: any): DeliveryRecord {
    return {
      id: d.id,
      userId: d.userId,
      type: d.type as DeliveryType,
      channel: d.channel as DeliveryChannel,
      status: d.status as DeliveryStatus,
      dedupeKey: d.dedupeKey,
      createdAt: d.createdAt,
      ...(d.sentAt != null ? { sentAt: d.sentAt } : {}),
      ...(d.error != null ? { error: d.error } : {}),
      attempts: d.attempts ?? 0,
      ...(d.nextAttemptAt != null ? { nextAttemptAt: d.nextAttemptAt } : {}),
      ...(d.deadLetteredAt != null ? { deadLetteredAt: d.deadLetteredAt } : {}),
      ...(d.lastError != null ? { lastError: d.lastError } : {}),
      ...(d.context != null ? { context: d.context as DeliveryContext } : {}),
    };
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

    return deliveries.map((d) => this.toDeliveryRecord(d));
  }

  /**
   * Get in-app notification inbox for a user (#1513).
   * Returns notifications with acknowledgement/read status.
   */
  async getInboxNotifications(
    userId: string,
    options: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
  ): Promise<any> {
    const { limit = 20, offset = 0, unreadOnly = false } = options;

    const where: any = {
      userId,
      channel: "in_app",
    };

    if (unreadOnly) {
      where.status = { not: "delivered" };
    }

    const notifications = await this.prisma.notificationDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await this.prisma.notificationDelivery.count({
      where: {
        userId,
        channel: "in_app",
        ...(unreadOnly && { status: { not: "delivered" } }),
      },
    });

    return {
      items: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        message: `${n.type.charAt(0).toUpperCase() + n.type.slice(1)} notification`,
        isRead: n.status === "delivered",
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Acknowledge (mark as read) a notification in the inbox (#1513).
   */
  async acknowledgeNotification(userId: string, notificationId: string): Promise<boolean> {
    const notification = await this.prisma.notificationDelivery.findUnique({
      where: { id: notificationId },
    });

    if (!notification || notification.userId !== userId) {
      return false;
    }

    await this.prisma.notificationDelivery.update({
      where: { id: notificationId },
      data: { status: "delivered" },
    });

    return true;
  }
}
