import { describe, expect, it, jest } from "@jest/globals";
import type { PrismaClient } from "@prisma/client";
import { OutboxStore, type OutboxMessage } from "../../src/services/outbox/outboxStore";
import { OutboxDispatcher } from "../../src/workers/outboxDispatcher";

const message: OutboxMessage & { leaseOwner: string } = {
  id: "event-1",
  eventType: "arena.projection.updated",
  aggregateId: "arena-1",
  dedupeKey: "projection:arena-1:ledger-10",
  payload: { arenaId: "arena-1", lastLedgerSequence: 10 },
  attempts: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  leaseOwner: "lease-1",
};

class FakeOutboxStore extends OutboxStore {
  markPublished = jest
    .fn<(id: string, leaseOwner: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  scheduleRetry = jest.fn<
    (id: string, leaseOwner: string, attempts: number, error: unknown) => Promise<void>
  >().mockResolvedValue(undefined);

  constructor() {
    super({} as PrismaClient);
  }

  override async claimBatch(): Promise<(OutboxMessage & { leaseOwner: string })[]> {
    return [message];
  }
}

describe("OutboxDispatcher", () => {
  it("acknowledges an event only after publication succeeds", async () => {
    const store = new FakeOutboxStore();
    const publish = jest
      .fn<(event: OutboxMessage) => Promise<void>>()
      .mockResolvedValue(undefined);
    const dispatcher = new OutboxDispatcher(store, publish);

    await expect(dispatcher.processBatch()).resolves.toBe(1);
    expect(publish).toHaveBeenCalledWith(message);
    expect(store.markPublished).toHaveBeenCalledWith("event-1", "lease-1");
    expect(store.scheduleRetry).not.toHaveBeenCalled();
  });

  it("releases failed publications for retry and preserves explicit failure reporting", async () => {
    const store = new FakeOutboxStore();
    const failure = new Error("Redis unavailable");
    const publish = jest.fn<(event: OutboxMessage) => Promise<void>>().mockRejectedValue(failure);
    const dispatcher = new OutboxDispatcher(store, publish);

    await expect(dispatcher.processBatch()).resolves.toBe(1);
    expect(store.scheduleRetry).toHaveBeenCalledWith("event-1", "lease-1", 1, failure);
    expect(store.markPublished).not.toHaveBeenCalled();
  });
});
