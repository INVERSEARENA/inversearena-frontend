import type { Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import { OutboxStore, type OutboxMessage } from "../services/outbox/outboxStore";

export type OutboxPublisher = (message: OutboxMessage) => Promise<void>;

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private processing: Promise<void> | undefined;

  constructor(
    private readonly store: OutboxStore,
    private readonly publish: OutboxPublisher,
    private readonly pollIntervalMs = 1_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.processing;
  }

  async processBatch(limit = 25): Promise<number> {
    const messages = await this.store.claimBatch(limit);
    for (const message of messages) {
      try {
        await this.publish(message);
        await this.store.markPublished(message.id, message.leaseOwner);
      } catch (error) {
        logger.error(
          {
            outboxEventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            attempts: message.attempts,
            err: error,
          },
          "Outbox event publication failed; retry scheduled",
        );
        await this.store.scheduleRetry(message.id, message.leaseOwner, message.attempts, error);
      }
    }
    return messages.length;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.processing = this.processBatch()
        .then(() => undefined)
        .catch((error: unknown) => {
          logger.error({ err: error }, "Outbox batch claim failed");
        })
        .finally(() => {
          this.processing = undefined;
          this.schedule(this.pollIntervalMs);
        });
    }, delay);
    this.timer.unref();
  }
}

export function outboxPayloadObject(payload: Prisma.JsonValue): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Outbox event payload must be a JSON object");
  }
  return payload as Record<string, unknown>;
}
