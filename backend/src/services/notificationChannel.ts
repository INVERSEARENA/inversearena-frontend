/**
 * Common notification channel contract (#1735).
 *
 * Every delivery backend — Web Push, Telegram, Discord and community
 * webhooks — is addressed through this interface. The pipeline owns
 * preference checks, dedupe, retries and dead-lettering; adapters only know
 * how to talk to their platform and how to classify failures.
 */

export const NOTIFICATION_CHANNELS = [
  "push",
  "telegram",
  "discord",
  "webhook",
  "email",
  "in_app",
] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_EVENTS = [
  "round",
  "payout",
  "elimination",
  "rematch",
  "arena_announcement",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];

export interface NotificationMessage {
  title: string;
  body: string;
  /** Deep link opened when the notification supports click-through. */
  url: string;
  /** Stable client-side dedupe/replace tag. */
  tag?: string;
}

export interface NotificationDeliveryContext {
  eventType: NotificationEventType;
  dedupeKey: string;
  arenaId?: string;
  message: NotificationMessage;
}

/**
 * Adapters return one of four outcomes:
 * - `delivered`: the platform accepted the message;
 * - `retryable`: transient/rate-limit failure — pipeline applies backoff;
 * - `failed`: permanent failure (invalid/expired link, webhook removed);
 * - `skipped`: no active destination for this user/arena, no delivery record.
 */
export interface ChannelSendResult {
  status: "delivered" | "retryable" | "failed" | "skipped";
  error?: string;
  retryAfterMs?: number;
  externalId?: string;
}

export interface NotificationChannel {
  readonly channel: NotificationChannelType;
  send(
    userId: string,
    message: NotificationMessage,
    context: NotificationDeliveryContext,
  ): Promise<ChannelSendResult>;
}

export function isNotificationChannel(value: unknown): value is NotificationChannelType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
  );
}

export function isNotificationEvent(value: unknown): value is NotificationEventType {
  return typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** Shared plain-text rendering for bot/webhook destinations. */
export function formatNotificationText(
  message: NotificationMessage,
  options: { urlLabel?: string } = {},
): string {
  const label = options.urlLabel ?? "Open arena";
  return message.tag
    ? `${message.title}\n\n${message.body}\n\n[${label}](${message.url})`
    : `${message.title}\n\n${message.body}\n\n${message.url}`;
}
