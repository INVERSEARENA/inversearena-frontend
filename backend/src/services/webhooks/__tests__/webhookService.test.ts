import { createHmac } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { WebhookService, type WebhookPayload } from "../webhookService";

describe("WebhookService", () => {
  let service: WebhookService;
  let prisma: PrismaClient;

  // Mock Prisma
  const mockPrisma = {
    webhookSubscription: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    webhookDeliveryLog: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
  } as unknown as PrismaClient;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WebhookService(mockPrisma);
    prisma = mockPrisma;
  });

  describe("isUrlAllowed", () => {
    it("should reject localhost", () => {
      expect(service.isUrlAllowed("http://localhost:8080/webhook")).toBe(false);
    });

    it("should reject 127.0.0.1", () => {
      expect(service.isUrlAllowed("http://127.0.0.1/webhook")).toBe(false);
    });

    it("should reject private IP ranges", () => {
      expect(service.isUrlAllowed("http://192.168.1.1/webhook")).toBe(false);
      expect(service.isUrlAllowed("http://10.0.0.1/webhook")).toBe(false);
      expect(service.isUrlAllowed("http://172.16.0.1/webhook")).toBe(false);
      expect(service.isUrlAllowed("http://172.31.255.255/webhook")).toBe(false);
    });

    it("should allow public URLs", () => {
      expect(service.isUrlAllowed("https://example.com/webhook")).toBe(true);
      expect(service.isUrlAllowed("https://api.example.com/webhook")).toBe(true);
    });

    it("should reject invalid URLs", () => {
      expect(service.isUrlAllowed("not a url")).toBe(false);
    });
  });

  describe("createSubscription", () => {
    it("should create a subscription with valid URL", async () => {
      const input = {
        url: "https://example.com/webhook",
        secret: "a".repeat(32),
        eventFilters: ["arena.created"],
      };

      (prisma.webhookSubscription.create as jest.Mock).mockResolvedValue({
        id: "sub-123",
      });

      const result = await service.createSubscription(input);

      expect(result.id).toBe("sub-123");
      expect(prisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: {
          url: input.url,
          secret: input.secret,
          eventFilters: input.eventFilters,
        },
        select: { id: true },
      });
    });

    it("should reject subscription with private IP", async () => {
      const input = {
        url: "http://192.168.1.1/webhook",
        secret: "a".repeat(32),
      };

      await expect(service.createSubscription(input)).rejects.toThrow(
        "SSRF validation"
      );
    });

    it("should default eventFilters to [*]", async () => {
      const input = {
        url: "https://example.com/webhook",
        secret: "a".repeat(32),
      };

      (prisma.webhookSubscription.create as jest.Mock).mockResolvedValue({
        id: "sub-123",
      });

      await service.createSubscription(input);

      expect(prisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: {
          url: input.url,
          secret: input.secret,
          eventFilters: ["*"],
        },
        select: { id: true },
      });
    });
  });

  describe("matchesFilters", () => {
    it("should match all events if filters empty or [*]", () => {
      expect(service.matchesFilters("arena.created", [])).toBe(true);
      expect(service.matchesFilters("arena.created", ["*"])).toBe(true);
    });

    it("should match specific event type", () => {
      expect(
        service.matchesFilters("arena.created", ["arena.created", "arena.resolved"])
      ).toBe(true);
    });

    it("should not match excluded event type", () => {
      expect(service.matchesFilters("arena.created", ["arena.resolved"])).toBe(
        false
      );
    });
  });

  describe("createSignature & verifySignature", () => {
    it("should create and verify a valid signature", () => {
      const payload: WebhookPayload = {
        id: "evt-123",
        timestamp: new Date().toISOString(),
        eventType: "arena.created",
        aggregateId: "arena-456",
        data: { foo: "bar" },
      };
      const secret = "my-secret-key";

      const signature = service.createSignature(payload, secret);
      const isValid = service.verifySignature(payload, signature, secret);

      expect(isValid).toBe(true);
    });

    it("should reject signature with wrong secret", () => {
      const payload: WebhookPayload = {
        id: "evt-123",
        timestamp: new Date().toISOString(),
        eventType: "arena.created",
        aggregateId: "arena-456",
        data: { foo: "bar" },
      };
      const secret = "my-secret-key";
      const wrongSecret = "different-secret";

      const signature = service.createSignature(payload, secret);
      const isValid = service.verifySignature(payload, signature, wrongSecret);

      expect(isValid).toBe(false);
    });

    it("should reject old signatures", () => {
      const payload: WebhookPayload = {
        id: "evt-123",
        timestamp: new Date().toISOString(),
        eventType: "arena.created",
        aggregateId: "arena-456",
        data: { foo: "bar" },
      };
      const secret = "my-secret-key";

      const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const oldSignature = `ts=${oldTs},sig=fakesig`;

      const isValid = service.verifySignature(payload, oldSignature, secret, 300);
      expect(isValid).toBe(false);
    });
  });

  describe("getActiveSubscriptionsFor", () => {
    it("should fetch active subscriptions for event type", async () => {
      const mockSubs = [
        {
          id: "sub-1",
          url: "https://example.com/webhook",
          secret: "secret-1",
          eventFilters: ["arena.created"],
        },
      ];

      (prisma.webhookSubscription.findMany as jest.Mock).mockResolvedValue(
        mockSubs
      );

      const result = await service.getActiveSubscriptionsFor("arena.created");

      expect(result).toEqual(mockSubs);
      expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith({
        where: { status: "active" },
        select: {
          id: true,
          url: true,
          secret: true,
          eventFilters: true,
        },
      });
    });
  });
});
