import type {
  ChannelSendResult,
  NotificationChannel,
  NotificationDeliveryContext,
  NotificationMessage,
} from "../notificationChannel";
import type { PushService } from "../pushService";

/**
 * Web Push adapter (#1735). All RFC 8291/VAPID behaviour stays in
 * PushService; this class only translates the user-level result into the
 * common channel contract.
 */
export class PushChannel implements NotificationChannel {
  readonly channel = "push" as const;

  constructor(private readonly pushService: PushService) {}

  async send(
    userId: string,
    message: NotificationMessage,
    _context: NotificationDeliveryContext,
  ): Promise<ChannelSendResult> {
    try {
      const result = await this.pushService.sendToUser(userId, {
        ...message,
        tag: message.tag ?? `notification-${message.url}`,
      });
      if (result.skipped) {
        return { status: "skipped", ...(result.error ? { error: result.error } : {}) };
      }
      if (result.delivered) return { status: "delivered" };
      return {
        status: result.failed > 0 ? "retryable" : "failed",
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (err) {
      return { status: "retryable", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
