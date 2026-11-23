import { createHmac } from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger";

export interface WebhookPayload {
  id: string;
  timestamp: string;
  eventType: string;
  aggregateId: string;
  data: Prisma.JsonValue;
}

export interface SignedWebhookEnvelope {
  payload: WebhookPayload;
  signature: string; // "ts=<timestamp>,sig=<hmac-sha256>"
}

const FAILURE_THRESHOLD = 10; // Auto-disable after 10 consecutive failures
const MAX_PAYLOAD_SIZE = 1_024 * 256; // 256 KB
const TIMEOUT_MS = 5_000; // 5 second timeout per delivery
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^localhost$/i,
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^::1$/,
  /^\[::1\]$/,
];

export class WebhookService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Validate webhook URL for SSRF: reject private IPs, localhost, etc.
   */
  isUrlAllowed(urlString: string): boolean {
    try {
      const url = new URL(urlString);
      const hostname = url.hostname;

      // Reject private IP patterns
      return !PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
    } catch {
      return false;
    }
  }

  /**
   * Register a new webhook subscription.
   */
  async createSubscription(input: {
    url: string;
    secret: string;
    eventFilters?: string[];
  }): Promise<{ id: string }> {
    if (!this.isUrlAllowed(input.url)) {
      throw new Error("Webhook URL fails SSRF validation (private IP or localhost)");
    }

    const subscription = await this.prisma.webhookSubscription.create({
      data: {
        url: input.url,
        secret: input.secret,
        eventFilters: input.eventFilters?.length ? input.eventFilters : ["*"],
      },
      select: { id: true },
    });

    return subscription;
  }

  /**
   * Get active subscriptions for a given event type.
   */
  async getActiveSubscriptionsFor(eventType: string): Promise<
    Array<{
      id: string;
      url: string;
      secret: string;
      eventFilters: string[];
    }>
  > {
    return this.prisma.webhookSubscription.findMany({
      where: { status: "active" },
      select: {
        id: true,
        url: true,
        secret: true,
        eventFilters: true,
      },
    });
  }

  /**
   * Check if an event matches subscription filters.
   */
  matchesFilters(eventType: string, filters: string[]): boolean {
    if (filters.length === 0 || filters.includes("*")) {
      return true;
    }
    return filters.includes(eventType);
  }

  /**
   * Create HMAC-256 signature with timestamp.
   */
  createSignature(payload: WebhookPayload, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `${timestamp}.${JSON.stringify(payload)}`;
    const hmac = createHmac("sha256", secret);
    hmac.update(message);
    const sig = hmac.digest("hex");
    return `ts=${timestamp},sig=${sig}`;
  }

  /**
   * Verify webhook signature and timestamp (5 min tolerance).
   */
  verifySignature(
    payload: WebhookPayload,
    signature: string,
    secret: string,
    toleranceSec = 300,
  ): boolean {
    const parts = signature.split(",");
    const tsPart = parts.find((p) => p.startsWith("ts="));
    const sigPart = parts.find((p) => p.startsWith("sig="));

    if (!tsPart || !sigPart) return false;

    const timestamp = parseInt(tsPart.slice(3), 10);
    const sig = sigPart.slice(4);

    // Check timestamp freshness
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSec) {
      return false;
    }

    // Verify HMAC
    const message = `${timestamp}.${JSON.stringify(payload)}`;
    const hmac = createHmac("sha256", secret);
    hmac.update(message);
    const expectedSig = hmac.digest("hex");

    return sig === expectedSig;
  }

  /**
   * Dispatch a single outbox event to all matching subscriptions.
   * Returns idempotency key for deduplication.
   */
  async dispatchToSubscriptions(
    outboxEventId: string,
    eventType: string,
    aggregateId: string,
    payload: Prisma.JsonValue,
  ): Promise<void> {
    const subscriptions = await this.getActiveSubscriptionsFor(eventType);
    const filtered = subscriptions.filter((s) =>
      this.matchesFilters(eventType, s.eventFilters),
    );

    if (filtered.length === 0) return;

    const webhookPayload: WebhookPayload = {
      id: outboxEventId,
      timestamp: new Date().toISOString(),
      eventType,
      aggregateId,
      data: payload,
    };

    // Check payload size
    const payloadJson = JSON.stringify(webhookPayload);
    if (payloadJson.length > MAX_PAYLOAD_SIZE) {
      logger.warn(
        { outboxEventId, size: payloadJson.length },
        "Webhook payload exceeds size limit; skipping dispatch",
      );
      return;
    }

    // Queue deliveries asynchronously (fire-and-forget with logging)
    for (const sub of filtered) {
      this.queueDelivery(sub.id, sub.url, sub.secret, outboxEventId, webhookPayload).catch(
        (err) => {
          logger.error(
            { subscriptionId: sub.id, outboxEventId, err },
            "Failed to queue webhook delivery",
          );
        },
      );
    }
  }

  /**
   * Queue a single delivery attempt. Does not block.
   */
  private async queueDelivery(
    subscriptionId: string,
    url: string,
    secret: string,
    outboxEventId: string,
    payload: WebhookPayload,
  ): Promise<void> {
    const idempotencyKey = `${subscriptionId}:${outboxEventId}`;
    const signature = this.createSignature(payload, secret);
    const envelope: SignedWebhookEnvelope = { payload, signature };

    // Attempt delivery
    let httpStatus: number | null = null;
    let responseTime: number | null = null;
    let error: string | null = null;
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Id": outboxEventId,
          "X-Webhook-Timestamp": payload.timestamp,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      responseTime = Date.now() - startTime;
      httpStatus = response.status;

      if (response.status >= 400) {
        error = `HTTP ${response.status}`;
      }
    } catch (err) {
      responseTime = Date.now() - startTime;
      error = err instanceof Error ? err.message : String(err);
    }

    // Log delivery attempt
    const status = error ? "failed" : "delivered";
    await this.logDelivery(
      subscriptionId,
      outboxEventId,
      idempotencyKey,
      status,
      httpStatus,
      responseTime,
      error,
    );

    // Update subscription state
    if (error) {
      await this.recordFailure(subscriptionId);
    } else {
      await this.recordSuccess(subscriptionId);
    }
  }

  /**
   * Log a single delivery attempt.
   */
  private async logDelivery(
    subscriptionId: string,
    outboxEventId: string,
    idempotencyKey: string,
    status: "delivered" | "failed",
    httpStatus: number | null,
    responseTime: number | null,
    error: string | null,
  ): Promise<void> {
    try {
      await this.prisma.webhookDeliveryLog.upsert({
        where: { subscriptionId_idempotencyKey: { subscriptionId, idempotencyKey } },
        create: {
          subscriptionId,
          outboxEventId,
          idempotencyKey,
          status,
          httpStatus,
          responseTime,
          error,
        },
        update: {
          status,
          httpStatus,
          responseTime,
          error,
          attempt: { increment: 1 },
        },
      });
    } catch (err) {
      logger.error(
        { subscriptionId, outboxEventId, err },
        "Failed to log webhook delivery",
      );
    }
  }

  /**
   * Record a successful delivery; reset failure counter.
   */
  private async recordSuccess(subscriptionId: string): Promise<void> {
    await this.prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: {
        failureCount: 0,
        lastSuccessAt: new Date(),
      },
    });
  }

  /**
   * Record a failure; disable if threshold exceeded.
   */
  private async recordFailure(subscriptionId: string): Promise<void> {
    const subscription = await this.prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: {
        failureCount: { increment: 1 },
        lastFailedAt: new Date(),
      },
    });

    if (subscription.failureCount >= FAILURE_THRESHOLD) {
      await this.prisma.webhookSubscription.update({
        where: { id: subscriptionId },
        data: { status: "disabled" },
      });
      logger.warn(
        { subscriptionId, failureCount: subscription.failureCount },
        "Webhook subscription auto-disabled due to sustained failures",
      );
    }
  }

  /**
   * Get delivery logs for a subscription (for admin inspection).
   */
  async getDeliveryLogs(
    subscriptionId: string,
    limit = 100,
    offset = 0,
  ): Promise<
    Array<{
      id: string;
      outboxEventId: string;
      status: string;
      httpStatus: number | null;
      responseTime: number | null;
      error: string | null;
      attempt: number;
      createdAt: Date;
    }>
  > {
    return this.prisma.webhookDeliveryLog.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Manual replay: redeliver a specific outbox event to a subscription.
   */
  async replayDelivery(
    subscriptionId: string,
    outboxEventId: string,
  ): Promise<{ delivered: boolean; error?: string }> {
    // Fetch subscription and outbox event
    const [subscription, outboxEvent] = await Promise.all([
      this.prisma.webhookSubscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      }),
      this.prisma.outboxEvent.findUniqueOrThrow({
        where: { id: outboxEventId },
      }),
    ]);

    // Check filter match
    if (!this.matchesFilters(outboxEvent.eventType, subscription.eventFilters)) {
      return {
        delivered: false,
        error: "Event type does not match subscription filters",
      };
    }

    // Queue delivery with replay suffix in idempotency key
    const payload: WebhookPayload = {
      id: outboxEventId,
      timestamp: new Date().toISOString(),
      eventType: outboxEvent.eventType,
      aggregateId: outboxEvent.aggregateId,
      data: outboxEvent.payload,
    };

    const replayIdempotencyKey = `${subscriptionId}:${outboxEventId}:replay-${Date.now()}`;
    const signature = this.createSignature(payload, subscription.secret);
    const envelope: SignedWebhookEnvelope = { payload, signature };

    let httpStatus: number | null = null;
    let responseTime: number | null = null;
    let error: string | null = null;
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(subscription.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Id": outboxEventId,
          "X-Webhook-Timestamp": payload.timestamp,
          "X-Webhook-Replay": "true",
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      responseTime = Date.now() - startTime;
      httpStatus = response.status;

      if (response.status >= 400) {
        error = `HTTP ${response.status}`;
      }
    } catch (err) {
      responseTime = Date.now() - startTime;
      error = err instanceof Error ? err.message : String(err);
    }

    // Log replay attempt
    const status = error ? "failed" : "delivered";
    await this.logDelivery(
      subscriptionId,
      outboxEventId,
      replayIdempotencyKey,
      status,
      httpStatus,
      responseTime,
      error,
    );

    return {
      delivered: !error,
      error,
    };
  }
}
