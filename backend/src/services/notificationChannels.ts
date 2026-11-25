import type { NotificationPreferencesService } from "./notificationPreferencesService";

export type NotificationSendResult = "sent" | "expired";
export interface NotificationChannel<TSubscription, TMessage> {
  readonly name: "push" | "email" | "in_app" | (string & {});
  validateSubscription(subscription: TSubscription): Promise<void> | void;
  send(subscription: TSubscription, message: TMessage): Promise<NotificationSendResult>;
  mapError(error: unknown): { retryable: boolean; message: string };
}

export interface NotificationDeliveryStore<TSubscription> {
  list(userId: string): Promise<TSubscription[]>;
  removeExpired(userId: string, subscription: TSubscription): Promise<void>;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  expired: number;
  skipped: number;
}

export class NotificationScheduler {
  constructor(private readonly dispatcher: NotificationDispatcher) {}

  async fanout<TSubscription, TMessage>(input: {
    userIds: string[];
    preferenceType: "round" | "payout" | "elimination" | "rematch";
    dedupeKey: string;
    channel: NotificationChannel<TSubscription, TMessage>;
    store: NotificationDeliveryStore<TSubscription>;
    message: TMessage;
  }): Promise<DispatchResult> {
    const total: DispatchResult = { sent: 0, failed: 0, expired: 0, skipped: 0 };
    for (const userId of new Set(input.userIds)) {
      try {
        const result = await this.dispatcher.dispatch({ ...input, userId });
        total.sent += result.sent;
        total.failed += result.failed;
        total.expired += result.expired;
        total.skipped += result.skipped;
      } catch {
        total.failed += 1;
      }
    }
    return total;
  }
}

/** Shared preference, idempotency and delivery-ledger flow for every channel. */
export class NotificationDispatcher {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  async dispatch<TSubscription, TMessage>(input: {
    userId: string;
    preferenceType: "round" | "payout" | "elimination" | "rematch";
    dedupeKey: string;
    channel: NotificationChannel<TSubscription, TMessage>;
    store: NotificationDeliveryStore<TSubscription>;
    message: TMessage;
  }): Promise<DispatchResult> {
    const result: DispatchResult = { sent: 0, failed: 0, expired: 0, skipped: 0 };
    if (!(await this.preferences.shouldNotify(input.userId, input.preferenceType, input.channel.name as "push" | "email" | "in_app"))) {
      result.skipped = 1;
      return result;
    }
    if (await this.preferences.hasDelivered(input.userId, input.dedupeKey, input.channel.name as "push" | "email" | "in_app")) {
      result.skipped = 1;
      return result;
    }
    const deliveryId = await this.preferences.recordDelivery(input.userId, input.preferenceType, input.channel.name as "push" | "email" | "in_app", input.dedupeKey);
    const subscriptions = await input.store.list(input.userId);
    if (subscriptions.length === 0) {
      await this.preferences.markFailed(deliveryId, "no channel subscriptions");
      result.skipped = 1;
      return result;
    }
    for (const subscription of subscriptions) {
      try {
        await input.channel.validateSubscription(subscription);
        const outcome = await input.channel.send(subscription, input.message);
        if (outcome === "expired") {
          result.expired += 1;
          await input.store.removeExpired(input.userId, subscription);
        } else result.sent += 1;
      } catch (error) {
        result.failed += 1;
        const mapped = input.channel.mapError(error);
        // A retryable failure remains pending so the next scheduler pass can
        // retry it. Permanent failures are terminal in the shared ledger.
        if (!mapped.retryable) await this.preferences.markFailed(deliveryId, mapped.message);
      }
    }
    if (result.sent > 0) await this.preferences.markSent(deliveryId);
    else if (result.failed === 0) await this.preferences.markFailed(deliveryId, "all subscriptions expired");
    return result;
  }
}
