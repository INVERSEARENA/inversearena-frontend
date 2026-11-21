import type { Prisma, PrismaClient } from "@prisma/client";
import { OutboxDispatcher } from "../outboxDispatcher";
import { OutboxStore } from "../../services/outbox/outboxStore";
import { WebhookService } from "../../services/webhooks/webhookService";

describe("OutboxDispatcher with WebhookService", () => {
  let dispatcher: OutboxDispatcher;
  let mockOutboxStore: jest.Mocked<OutboxStore>;
  let mockWebhookService: jest.Mocked<WebhookService>;
  let publishCalls: Array<{
    id: string;
    eventType: string;
    aggregateId: string;
    payload: Prisma.JsonValue;
  }>;

  beforeEach(() => {
    publishCalls = [];

    mockOutboxStore = {
      claimBatch: jest.fn(),
      markPublished: jest.fn(),
      scheduleRetry: jest.fn(),
    } as unknown as jest.Mocked<OutboxStore>;

    mockWebhookService = {
      dispatchToSubscriptions: jest.fn(),
    } as unknown as jest.Mocked<WebhookService>;

    const testPublisher = async (message: any) => {
      publishCalls.push({
        id: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        payload: message.payload,
      });
    };

    dispatcher = new OutboxDispatcher(
      mockOutboxStore,
      testPublisher,
      mockWebhookService,
      1000
    );
  });

  it("should dispatch webhook for each outbox event", async () => {
    const mockMessage = {
      id: "evt-1",
      eventType: "arena.created",
      aggregateId: "arena-123",
      dedupeKey: "key-1",
      payload: { arenaId: "arena-123", entryFee: 100 },
      attempts: 1,
      createdAt: new Date(),
      leaseOwner: "owner-1",
    };

    (mockOutboxStore.claimBatch as jest.Mock).mockResolvedValue([mockMessage]);

    await dispatcher.processBatch(1);

    expect(mockWebhookService.dispatchToSubscriptions).toHaveBeenCalledWith(
      "evt-1",
      "arena.created",
      "arena-123",
      { arenaId: "arena-123", entryFee: 100 }
    );
  });

  it("should mark event published even if webhook dispatch fails", async () => {
    const mockMessage = {
      id: "evt-1",
      eventType: "arena.created",
      aggregateId: "arena-123",
      dedupeKey: "key-1",
      payload: { arenaId: "arena-123" },
      attempts: 1,
      createdAt: new Date(),
      leaseOwner: "owner-1",
    };

    (mockOutboxStore.claimBatch as jest.Mock).mockResolvedValue([mockMessage]);
    (mockWebhookService.dispatchToSubscriptions as jest.Mock).mockRejectedValue(
      new Error("Webhook dispatch failed")
    );

    await dispatcher.processBatch(1);

    // Should still mark as published despite webhook error
    expect(mockOutboxStore.markPublished).toHaveBeenCalledWith("evt-1", "owner-1");
  });

  it("should retry event on publisher failure", async () => {
    const mockMessage = {
      id: "evt-1",
      eventType: "arena.created",
      aggregateId: "arena-123",
      dedupeKey: "key-1",
      payload: { arenaId: "arena-123" },
      attempts: 1,
      createdAt: new Date(),
      leaseOwner: "owner-1",
    };

    (mockOutboxStore.claimBatch as jest.Mock).mockResolvedValue([mockMessage]);

    const publishError = new Error("Publisher failed");
    const testPublisherFails = jest.fn().mockRejectedValue(publishError);

    const dispatcherWithFailure = new OutboxDispatcher(
      mockOutboxStore,
      testPublisherFails,
      mockWebhookService,
      1000
    );

    await dispatcherWithFailure.processBatch(1);

    expect(mockOutboxStore.scheduleRetry).toHaveBeenCalledWith(
      "evt-1",
      "owner-1",
      1,
      publishError
    );
  });

  it("should handle multiple events in batch", async () => {
    const mockMessages = [
      {
        id: "evt-1",
        eventType: "arena.created",
        aggregateId: "arena-123",
        dedupeKey: "key-1",
        payload: { arenaId: "arena-123" },
        attempts: 1,
        createdAt: new Date(),
        leaseOwner: "owner-1",
      },
      {
        id: "evt-2",
        eventType: "arena.resolved",
        aggregateId: "arena-124",
        dedupeKey: "key-2",
        payload: { arenaId: "arena-124", winner: "player-1" },
        attempts: 1,
        createdAt: new Date(),
        leaseOwner: "owner-2",
      },
    ];

    (mockOutboxStore.claimBatch as jest.Mock).mockResolvedValue(mockMessages);

    await dispatcher.processBatch(2);

    expect(mockWebhookService.dispatchToSubscriptions).toHaveBeenCalledTimes(2);
    expect(mockOutboxStore.markPublished).toHaveBeenCalledTimes(2);
  });
});
