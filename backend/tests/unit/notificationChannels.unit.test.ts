import { describe, expect, it, jest } from "@jest/globals";
import { generateKeyPairSync, randomBytes, sign } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { NotificationCrypto } from "../../src/services/notificationCrypto";
import {
  NotificationLinkError,
  NotificationLinkService,
} from "../../src/services/notificationLinkService";
import type { NotificationDeliveryContext, NotificationMessage } from "../../src/services/notificationChannel";
import type { PushService } from "../../src/services/pushService";
import { PushChannel } from "../../src/services/channels/pushChannel";
import { TelegramChannel } from "../../src/services/channels/telegramChannel";
import { DiscordChannel } from "../../src/services/channels/discordChannel";
import { WebhookChannel } from "../../src/services/channels/webhookChannel";

const MESSAGE: NotificationMessage = {
  title: "Round resolved",
  body: "The next commit window is opening.",
  url: "/arena/arena-1",
  tag: "arena-arena-1-round-1-started",
};

const CONTEXT: NotificationDeliveryContext = {
  eventType: "round",
  dedupeKey: "round:arena-1:1",
  arenaId: "arena-1",
  message: MESSAGE,
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function fakeLinks(overrides: Partial<NotificationLinkService> = {}): NotificationLinkService {
  return {
    consumeCode: jest.fn(async () => ({
      userId: "user-1",
      link: {
        id: "link-1",
        channel: "telegram",
        externalId: "chat-1",
        displayName: null,
        active: true,
        linkedAt: new Date(),
      },
    })),
    getActiveLink: jest.fn(async () => null),
    deactivateByExternalId: jest.fn(async () => undefined),
    updateMetadata: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as NotificationLinkService;
}

describe("PushChannel (#1735)", () => {
  it("adapts PushService's user-level result to the common contract", async () => {
    const pushService = {
      sendToUser: jest.fn(async () => ({
        delivered: true,
        sent: 2,
        expired: 0,
        failed: 0,
        skipped: false,
      })),
    } as unknown as PushService;
    const channel = new PushChannel(pushService);

    await expect(channel.send("user-1", MESSAGE, CONTEXT)).resolves.toEqual({
      status: "delivered",
    });
    expect(pushService.sendToUser).toHaveBeenCalledWith("user-1", expect.objectContaining(MESSAGE));
  });
});

describe("TelegramChannel (#1735)", () => {
  it("links a wallet from /start CODE and verifies the webhook secret", async () => {
    const links = fakeLinks();
    const channel = new TelegramChannel({
      token: "test-token",
      webhookSecret: "test-webhook-secret",
      sender: jest.fn(async () => response(200, { ok: true })),
      linkService: links,
    });

    const result = await channel.processUpdate({
      message: {
        text: "/start ABC12345",
        chat: { id: 98765, username: "arena_player" },
      },
    });

    expect(result).toEqual({ handled: true, linked: true });
    expect(links.consumeCode).toHaveBeenCalledWith(
      "telegram",
      "ABC12345",
      "98765",
      expect.objectContaining({ displayName: "arena_player" }),
    );
    expect(channel.verifyWebhookSecret("test-webhook-secret")).toBe(true);
    expect(channel.verifyWebhookSecret("wrong")).toBe(false);
  });

  it("returns a stable reason for invalid codes and deactivates blocked bots", async () => {
    const invalidLinks = fakeLinks({
      consumeCode: jest.fn(async () => {
        throw new NotificationLinkError("INVALID_CODE");
      }),
    } as any);
    const invalidChannel = new TelegramChannel({
      token: "test-token",
      linkService: invalidLinks,
    });
    await expect(
      invalidChannel.processUpdate({ message: { text: "/start NOPE", chat: { id: 1 } } }),
    ).resolves.toEqual({ handled: true, reason: "INVALID_CODE" });

    const links = fakeLinks({
      getActiveLink: jest.fn(async () => ({
        id: "link-1",
        userId: "user-1",
        externalId: "chat-blocked",
        channel: "telegram",
        displayName: null,
        metadata: null,
        active: true,
      })),
    } as any);
    const channel = new TelegramChannel({
      token: "test-token",
      apiBaseUrl: "https://telegram.test",
      sender: jest.fn(async () =>
        response(403, { ok: false, description: "Bot was blocked by the user" }),
      ),
      linkService: links,
    });

    await expect(channel.send("user-1", MESSAGE, CONTEXT)).resolves.toMatchObject({
      status: "failed",
    });
    expect(links.deactivateByExternalId).toHaveBeenCalledWith("telegram", "chat-blocked");

    await channel.processUpdate({
      my_chat_member: { chat: { id: 42 }, new_chat_member: { status: "kicked" } },
    });
    expect(links.deactivateByExternalId).toHaveBeenCalledWith("telegram", "42");
  });

  it("classifies rate limits as retryable with Telegram's retry_after", async () => {
    const links = fakeLinks({
      getActiveLink: jest.fn(async () => ({
        id: "link-1",
        userId: "user-1",
        externalId: "chat-1",
        channel: "telegram",
        displayName: null,
        metadata: null,
        active: true,
      })),
    } as any);
    const channel = new TelegramChannel({
      token: "test-token",
      sender: jest.fn(async () =>
        response(429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }),
      ),
      linkService: links,
    });

    await expect(channel.send("user-1", MESSAGE, CONTEXT)).resolves.toEqual({
      status: "retryable",
      error: "Too Many Requests",
      retryAfterMs: 3000,
    });
  });
});

describe("DiscordChannel (#1735)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const timestamp = "1763640000";

  function signBody(rawBody: Buffer): string {
    return sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString("hex");
  }

  it("verifies Ed25519 interactions over the raw body and rejects stale requests", () => {
    const channel = new DiscordChannel({
      publicKey: publicKeyHex,
      now: () => Number(timestamp) * 1000,
    });
    const rawBody = Buffer.from(JSON.stringify({ type: 1 }));

    expect(channel.verifyInteractionSignature(rawBody, signBody(rawBody), timestamp)).toBe(true);
    expect(
      channel.verifyInteractionSignature(Buffer.from("tampered"), signBody(rawBody), timestamp),
    ).toBe(false);
    expect(channel.verifyInteractionSignature(rawBody, signBody(rawBody), "1700000000")).toBe(false);
  });

  it("links via /link CODE and handles ping interactions", async () => {
    const links = fakeLinks();
    const channel = new DiscordChannel({ linkService: links });
    const interaction = {
      type: 2,
      data: { name: "link", options: [{ name: "code", value: "ABC12345" }] },
      member: { user: { id: "discord-1", username: "arena_player" } },
    };

    const result = await channel.handleInteraction(interaction);

    expect(result.type).toBe(4);
    expect(links.consumeCode).toHaveBeenCalledWith(
      "discord",
      "ABC12345",
      "discord-1",
      expect.objectContaining({ displayName: "arena_player" }),
    );
    await expect(channel.handleInteraction({ type: 1 })).resolves.toEqual({ type: 1 });
    await expect(channel.handleInteraction({ type: 2, data: { name: "link" } })).resolves.toMatchObject({
      type: 4,
      data: { content: "Usage: `/link YOUR_CODE`" },
    });
  });

  it("classifies Discord rate limits and caches the DM channel", async () => {
    const links = fakeLinks({
      getActiveLink: jest.fn(async () => ({
        id: "link-1",
        userId: "user-1",
        externalId: "discord-1",
        channel: "discord",
        displayName: null,
        metadata: { dmChannelId: "dm-1" },
        active: true,
      })),
    } as any);
    const sender = jest.fn(async () => response(429, { retry_after: 2.4, message: "rate limited" }));
    const channel = new DiscordChannel({
      token: "test-token",
      sender,
      linkService: links,
    });

    await expect(channel.send("user-1", MESSAGE, CONTEXT)).resolves.toEqual({
      status: "retryable",
      error: "rate limited",
      retryAfterMs: 2400,
    });
    expect(links.getActiveLink).toHaveBeenCalledWith("user-1", "discord");
    expect(sender).toHaveBeenCalledTimes(1);
  });
});

describe("WebhookChannel (#1735)", () => {
  function fakePrisma(rows: any[] = []) {
    return {
      arenaNotificationWebhook: {
        create: jest.fn(async ({ data }: any) => {
          const row = {
            id: "webhook-1",
            createdAt: new Date(),
            active: true,
            ...data,
          };
          rows.push(row);
          return row;
        }),
        findMany: jest.fn(async () => rows),
        findUnique: jest.fn(async () => rows[0] ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        }),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
    } as unknown as PrismaClient;
  }

  const key = randomBytes(32);
  const crypto = new NotificationCrypto(key);
  const url = "https://discord.com/api/webhooks/123/abc";

  it("encrypts webhook URLs at rest and masks them in listings", async () => {
    const prisma = fakePrisma();
    const channel = new WebhookChannel(prisma, { crypto });

    const created = await channel.createWebhook("arena-1", "user-1", url, "Community");
    const stored = (prisma.arenaNotificationWebhook.create as jest.Mock).mock.calls[0][0].data.url;

    expect(stored).not.toContain("abc");
    expect(created.urlMasked).toContain("https://discord.com");
    expect(created.urlMasked).not.toContain("abc");
    expect((await channel.listWebhooks("arena-1"))[0].urlMasked).toBe(created.urlMasked);
  });

  it("posts one encrypted webhook payload with event metadata", async () => {
    const encrypted = crypto.encrypt(url);
    const prisma = fakePrisma([{ id: "webhook-1", url: encrypted }]);
    const sender = jest.fn(async () => response(204, undefined));
    const channel = new WebhookChannel(prisma, { crypto, sender });

    await expect(channel.send("host-1", MESSAGE, CONTEXT)).resolves.toEqual({ status: "delivered" });
    expect(sender).toHaveBeenCalledTimes(1);
    const [requestedUrl, init] = (sender as jest.Mock).mock.calls[0];
    expect(requestedUrl).toBe(url);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      eventType: "round",
      arenaId: "arena-1",
      title: MESSAGE.title,
    });
  });

  it("deactivates a webhook after a permanent failure", async () => {
    const rows = [{ id: "webhook-1", url: crypto.encrypt(url), active: true }];
    const prisma = fakePrisma(rows);
    const sender = jest.fn(async () => response(404, { message: "not found" }));
    const channel = new WebhookChannel(prisma, { crypto, sender });

    await expect(channel.send("host-1", MESSAGE, CONTEXT)).resolves.toMatchObject({
      status: "failed",
    });
    expect(rows[0].active).toBe(false);
  });
});
