/**
 * Web Push Notification Service
 * 
 * Handles batch web push notifications with:
 * - Bulk queueing via BullMQ addBulk
 * - Rate limiting per endpoint host
 * - Subscription pruning
 * - Delivery latency metrics
 */

import webpush from 'web-push';
import type { Queue } from 'bullmq';
import type {
  PushAlert,
  PushSubscription,
  PushJobData,
  PushResult,
  PushDeliveryMetrics,
} from '../types/push';
import {
  pushNotificationsSent,
  pushNotificationsFailed,
  pushDeliveryLatency,
  pushSubscriptionsPruned,
} from '../utils/metrics';

export class PushService {
  private rateLimiters = new Map<string, { count: number; resetAt: number }>();
  private readonly defaultRateLimit = 100; // requests per minute per host
  private readonly defaultTTL = 3600; // 1 hour

  constructor(private readonly pushQueue?: Queue<PushJobData>) {
    // Initialize web-push with VAPID keys
    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@inversearena.com';

    if (vapidPublicKey && vapidPrivateKey) {
      webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    } else {
      console.warn('[PushService] VAPID keys not configured - push notifications disabled');
    }
  }

  /**
   * Send alert to multiple subscriptions using bulk queueing
   * 
   * This is the main entry point for sending notifications
   */
  async sendAlertBulk(
    alert: PushAlert,
    subscriptions: PushSubscription[]
  ): Promise<{ queued: number; skipped: number }> {
    if (!this.pushQueue) {
      console.warn('[PushService] Queue not configured, falling back to sequential send');
      return this.sendAlertSequential(alert, subscriptions);
    }

    // Filter out expired subscriptions
    const now = Date.now();
    const validSubscriptions = subscriptions.filter(
      (sub) => !sub.expirationTime || sub.expirationTime > now
    );

    const skipped = subscriptions.length - validSubscriptions.length;

    // Check if alert is already stale
    if (alert.expiresAt && alert.expiresAt.getTime() < now) {
      console.log(`[PushService] Alert ${alert.id} is stale, skipping`);
      return { queued: 0, skipped: subscriptions.length };
    }

    // Create jobs for bulk queueing
    const jobs = validSubscriptions.map((subscription) => ({
      name: 'send-push',
      data: {
        alertId: alert.id,
        subscriptionId: subscription.id,
        alert,
        subscription,
        idempotencyKey: `${alert.id}:${subscription.id}`,
      } as PushJobData,
      opts: {
        jobId: `push:${alert.id}:${subscription.id}`, // Prevents duplicates
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }));

    // Bulk enqueue
    await this.pushQueue.addBulk(jobs);

    console.log(
      `[PushService] Bulk queued ${validSubscriptions.length} push notifications for alert ${alert.id}`
    );

    return { queued: validSubscriptions.length, skipped };
  }

  /**
   * Fallback: Send notifications sequentially (for testing/no-queue environments)
   */
  private async sendAlertSequential(
    alert: PushAlert,
    subscriptions: PushSubscription[]
  ): Promise<{ queued: number; skipped: number }> {
    let successful = 0;
    let failed = 0;

    for (const subscription of subscriptions) {
      try {
        await this.sendPushNotification(subscription, alert);
        successful++;
      } catch (error) {
        console.error(
          `[PushService] Failed to send to ${subscription.id}:`,
          error
        );
        failed++;
      }
    }

    return { queued: successful, skipped: failed };
  }

  /**
   * Send a single push notification
   * 
   * Called by the worker for each queued job
   */
  async sendPushNotification(
    subscription: PushSubscription,
    alert: PushAlert
  ): Promise<PushResult> {
    const startTime = Date.now();

    try {
      // Check if alert is stale
      if (alert.expiresAt && alert.expiresAt.getTime() < Date.now()) {
        console.log(
          `[PushService] Alert ${alert.id} expired, skipping subscription ${subscription.id}`
        );
        return {
          subscriptionId: subscription.id,
          success: false,
          error: 'Alert expired',
        };
      }

      // Rate limit check
      const host = this.extractHost(subscription.endpoint);
      if (!(await this.checkRateLimit(host))) {
        throw new Error(`Rate limit exceeded for ${host}`);
      }

      // Prepare push payload
      const payload = JSON.stringify({
        title: alert.title,
        body: alert.body,
        data: {
          alertId: alert.id,
          type: alert.type,
          ...alert.data,
        },
        timestamp: Date.now(),
      });

      // Send push notification
      const response = await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
          },
        },
        payload,
        {
          urgency: alert.urgency || 'normal',
          TTL: alert.ttl || this.defaultTTL,
        }
      );

      const deliveryLatencyMs = Date.now() - startTime;

      // Record metrics
      pushNotificationsSent.inc({ alert_type: alert.type });
      pushDeliveryLatency.observe(
        { alert_type: alert.type },
        deliveryLatencyMs / 1000
      );

      return {
        subscriptionId: subscription.id,
        success: true,
        statusCode: response.statusCode,
        deliveryLatencyMs,
      };
    } catch (error: any) {
      const deliveryLatencyMs = Date.now() - startTime;

      // Check if subscription should be pruned
      const shouldPrune = this.shouldPruneSubscription(error);

      if (shouldPrune) {
        console.log(
          `[PushService] Marking subscription ${subscription.id} for pruning`
        );
        pushSubscriptionsPruned.inc({ reason: 'expired' });
      }

      // Record metrics
      pushNotificationsFailed.inc({
        alert_type: alert.type,
        reason: shouldPrune ? 'subscription_invalid' : 'delivery_failed',
      });
      pushDeliveryLatency.observe(
        { alert_type: alert.type },
        deliveryLatencyMs / 1000
      );

      return {
        subscriptionId: subscription.id,
        success: false,
        statusCode: error.statusCode,
        error: error.message,
        shouldPrune,
        deliveryLatencyMs,
      };
    }
  }

  /**
   * Check rate limit for endpoint host
   */
  private async checkRateLimit(host: string): Promise<boolean> {
    const now = Date.now();
    const limiter = this.rateLimiters.get(host);

    if (!limiter || limiter.resetAt < now) {
      // Reset rate limiter
      this.rateLimiters.set(host, {
        count: 1,
        resetAt: now + 60_000, // 1 minute window
      });
      return true;
    }

    if (limiter.count >= this.defaultRateLimit) {
      return false;
    }

    limiter.count++;
    return true;
  }

  /**
   * Extract host from endpoint URL
   */
  private extractHost(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      return url.hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Determine if subscription should be pruned based on error
   */
  private shouldPruneSubscription(error: any): boolean {
    // HTTP 410: Gone - subscription expired
    if (error.statusCode === 410) {
      return true;
    }

    // HTTP 404: Not Found - subscription no longer exists
    if (error.statusCode === 404) {
      return true;
    }

    // Check for specific error messages indicating invalid subscription
    const message = error.message?.toLowerCase() || '';
    if (
      message.includes('expired') ||
      message.includes('unsubscribed') ||
      message.includes('invalid')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Calculate delivery metrics for an alert
   */
  calculateMetrics(results: PushResult[]): PushDeliveryMetrics {
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const pruned = results.filter((r) => r.shouldPrune).length;

    const latencies = results
      .filter((r) => r.deliveryLatencyMs !== undefined)
      .map((r) => r.deliveryLatencyMs!)
      .sort((a, b) => a - b);

    const averageLatencyMs =
      latencies.length > 0
        ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
        : 0;

    const p95Index = Math.floor(latencies.length * 0.95);
    const p99Index = Math.floor(latencies.length * 0.99);

    return {
      alertId: results[0]?.subscriptionId || 'unknown',
      totalSubscriptions: results.length,
      successful,
      failed,
      pruned,
      averageLatencyMs,
      p95LatencyMs: latencies[p95Index] || 0,
      p99LatencyMs: latencies[p99Index] || 0,
    };
  }
}
