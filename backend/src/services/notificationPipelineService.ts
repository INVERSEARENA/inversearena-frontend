import { env } from "../config/env";
import {
  type NotificationChannel,
  type NotificationChannelType,
  type NotificationEventType,
  type NotificationMessage,
} from "./notificationChannel";
import {
  type DeliveryContext,
  type DeliveryRecord,
  type DueDelivery,
  NotificationPreferencesService,
} from "./notificationPreferencesService";

const DEFAULT_CHANNELS: NotificationChannelType[] = ["push", "telegram", "discord", "webhook"];
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface DispatchNotificationInput {
  eventType: NotificationEventType;
  dedupeKey: string;
  message: NotificationMessage;
  userIds?: string[];
  arenaId?: string;
  /** Defaults to the four external delivery channels. */
  channels?: NotificationChannelType[];
}

export interface DispatchResult {
  delivered: number;
  failed: number;
  retrying: number;
  skipped: number;
}

export interface NotificationPipelineDeps {
  prefs: NotificationPreferencesService;
  channels: Partial<Record<NotificationChannelType, NotificationChannel>>;
  maxAttempts?: number;
  baseBackoffMs?: number;
  now?: () => Date;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Channel-agnostic notification fan-out (#1735).
 *
 * Owns preference checks, dedupe, delivery ledger writes, exponential-backoff
 * retries and dead-lettering. Adapters only translate a platform response
 * into `delivered | retryable | failed | skipped`.
 */
export class NotificationPipelineService {
  private readonly prefs: NotificationPreferencesService;
  private readonly channels: Partial<Record<NotificationChannelType, NotificationChannel>>;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => Date;

  constructor(deps: NotificationPipelineDeps) {
    this.prefs = deps.prefs;
    this.channels = deps.channels;
    this.maxAttempts = deps.maxAttempts ?? positiveInt(env.NOTIFICATION_RETRY_MAX_ATTEMPTS, 5);
    this.baseBackoffMs = deps.baseBackoffMs ?? positiveInt(env.NOTIFICATION_RETRY_BASE_MS, 60_000);
    this.now = deps.now ?? (() => new Date());
  }

  async dispatch(input: DispatchNotificationInput): Promise<DispatchResult> {
    const result: DispatchResult = { delivered: 0, failed: 0, retrying: 0, skipped: 0 };
    const users = [...new Set(input.userIds ?? [])].filter(Boolean);
    const channels = input.channels ?? DEFAULT_CHANNELS;

    for (const channelName of channels) {
      const channel = this.channels[channelName];
      if (!channel) {
        result.skipped += 1;
        continue;
      }

      // Webhooks are arena-wide, not per participant: one POST per arena
      // announcement rather than one per player.
      const recipients =
        channelName === "webhook" ? users.slice(0, 1) : users;
      if (recipients.length === 0) {
        result.skipped += 1;
        continue;
      }

      for (const userId of recipients) {
        try {
          const outcome = await this.deliver(userId, channelName, channel, input);
          result[outcome] += 1;
        } catch {
          result.failed += 1;
        }
      }
    }

    return result;
  }

  private async deliver(
    userId: string,
    channelName: NotificationChannelType,
    channel: NotificationChannel,
    input: DispatchNotificationInput,
  ): Promise<keyof DispatchResult> {
    const allowed = await this.prefs.isChannelEventEnabled(userId, input.eventType, channelName);
    if (!allowed) return "skipped";
    if (await this.prefs.hasDelivered(userId, input.dedupeKey, channelName)) return "skipped";

    const context: DeliveryContext = {
      ...(input.arenaId ? { arenaId: input.arenaId } : {}),
      message: input.message,
    };
    const deliveryId = await this.prefs.recordDelivery(
      userId,
      input.eventType,
      channelName,
      input.dedupeKey,
      context,
    );
    const sendResult = await channel.send(userId, input.message, {
      eventType: input.eventType,
      dedupeKey: input.dedupeKey,
      ...(input.arenaId ? { arenaId: input.arenaId } : {}),
      message: input.message,
    });

    if (sendResult.status === "delivered") {
      await this.prefs.markSent(deliveryId);
      return "delivered";
    }
    if (sendResult.status === "skipped") {
      // No destination: do not leave a misleading pending/dead record behind.
      await this.prefs.deleteDelivery(deliveryId);
      return "skipped";
    }
    if (sendResult.status === "retryable") {
      const queued = await this.scheduleRetry(
        deliveryId,
        1,
        sendResult.retryAfterMs,
        sendResult.error ?? "transient failure",
      );
      return queued ? "retrying" : "failed";
    }
    await this.prefs.markDeadLettered(deliveryId, 1, sendResult.error ?? "permanent failure");
    return "failed";
  }

  /** Returns false when the retry budget is exhausted and the row is dead-lettered. */
  private async scheduleRetry(
    deliveryId: string,
    attempts: number,
    retryAfterMs: number | undefined,
    error: string,
  ): Promise<boolean> {
    if (attempts >= this.maxAttempts) {
      await this.prefs.markDeadLettered(deliveryId, attempts, error);
      return false;
    }
    const backoff = Math.min(
      retryAfterMs ?? this.baseBackoffMs * Math.pow(2, attempts - 1),
      MAX_BACKOFF_MS,
    );
    await this.prefs.markRetrying(deliveryId, attempts, new Date(this.now().getTime() + backoff), error);
    return true;
  }

  /** Replay due deliveries. Intended for a cron/worker call every minute. */
  async processDueRetries(limit = 100): Promise<DispatchResult> {
    const result: DispatchResult = { delivered: 0, failed: 0, retrying: 0, skipped: 0 };
    const due = await this.prefs.getDueRetries(limit);
    for (const record of due) {
      try {
        const outcome = await this.retry(record);
        result[outcome] += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  private async retry(record: DueDelivery): Promise<keyof DispatchResult> {
    const channel = this.channels[record.channel];
    const message = record.context.message;
    if (
      !channel ||
      !message ||
      typeof message.title !== "string" ||
      typeof message.body !== "string" ||
      typeof message.url !== "string"
    ) {
      await this.prefs.markDeadLettered(record.id, record.attempts, "missing delivery context");
      return "failed";
    }

    const sendResult = await channel.send(record.userId, message, {
      eventType: record.type,
      dedupeKey: record.dedupeKey,
      ...(record.context.arenaId ? { arenaId: record.context.arenaId } : {}),
      message,
    });
    const attempts = record.attempts + 1;

    if (sendResult.status === "delivered") {
      await this.prefs.markSent(record.id);
      return "delivered";
    }
    if (sendResult.status === "retryable") {
      const queued = await this.scheduleRetry(
        record.id,
        attempts,
        sendResult.retryAfterMs,
        sendResult.error ?? "transient failure",
      );
      return queued ? "retrying" : "failed";
    }
    const error =
      sendResult.error ??
      (sendResult.status === "skipped" ? "no destination on retry" : "permanent failure");
    await this.prefs.markDeadLettered(record.id, attempts, error);
    return "failed";
  }
}

/** Exported for tests that need to construct a minimal delivery record. */
export type { DeliveryRecord };
