import { randomUUID } from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

export interface OutboxMessage {
  id: string;
  eventType: string;
  aggregateId: string;
  dedupeKey: string;
  payload: Prisma.JsonValue;
  attempts: number;
  createdAt: Date;
}

interface ClaimedOutboxMessage extends OutboxMessage {
  leaseOwner: string;
}

const DEFAULT_LEASE_MS = 30_000;

export class OutboxStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(
    tx: Prisma.TransactionClient,
    input: {
      eventType: string;
      aggregateId: string;
      dedupeKey: string;
      payload: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.outboxEvent.create({ data: input });
  }

  async appendOnce(
    tx: Prisma.TransactionClient,
    input: {
      eventType: string;
      aggregateId: string;
      dedupeKey: string;
      payload: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.outboxEvent.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: input,
      update: {},
    });
  }

  async claimBatch(limit = 25, leaseMs = DEFAULT_LEASE_MS): Promise<ClaimedOutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Outbox claim limit must be an integer between 1 and 1000");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Outbox lease duration must be a positive integer");
    }
    const leaseOwner = randomUUID();
    return this.prisma.$queryRaw<ClaimedOutboxMessage[]>`
      WITH candidates AS (
        SELECT id
        FROM outbox_events
        WHERE published_at IS NULL
          AND available_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE outbox_events AS event
      SET lease_owner = ${leaseOwner},
          lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
          attempts = event.attempts + 1
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id,
                event.event_type AS "eventType",
                event.aggregate_id AS "aggregateId",
                event.dedupe_key AS "dedupeKey",
                event.payload,
                event.attempts,
                event.created_at AS "createdAt",
                event.lease_owner AS "leaseOwner"
    `;
  }

  async markPublished(id: string, leaseOwner: string): Promise<void> {
    const result = await this.prisma.outboxEvent.updateMany({
      where: { id, leaseOwner, publishedAt: null },
      data: { publishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null },
    });
    if (result.count !== 1) {
      throw new Error(`Outbox lease was lost before acknowledging event ${id}`);
    }
  }

  async scheduleRetry(
    id: string,
    leaseOwner: string,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
    const message = error instanceof Error ? error.message : String(error);
    const result = await this.prisma.outboxEvent.updateMany({
      where: { id, leaseOwner, publishedAt: null },
      data: {
        availableAt: new Date(Date.now() + delayMs),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: message.slice(0, 2_000),
      },
    });
    if (result.count !== 1) {
      throw new Error(`Outbox lease was lost while scheduling retry for event ${id}`);
    }
  }
}
