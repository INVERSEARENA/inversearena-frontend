import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

jest.mock("../../src/db/prisma", () => ({
  prisma: {
    arena: {
      findUnique: jest.fn(),
    },
  },
}));

import { prisma } from "../../src/db/prisma";
import { errorHandler } from "../../src/middleware/errorHandler";
import {
  createCommunityWebhooksRouter,
  createNotificationBotWebhooksRouter,
  createNotificationChannelsRouter,
  createNotificationOpsRouter,
} from "../../src/routes/notificationChannels";

interface Mocks {
  prefs: any;
  links: any;
  telegram: any;
  discord: any;
  webhook: any;
  pipeline: any;
  deps: any;
}

function makeMocks(): Mocks {
  const prefs = {
    getPreferences: jest.fn(async (userId: string) => ({
      userId,
      emailEnabled: false,
      pushEnabled: true,
      telegramEnabled: false,
      discordEnabled: false,
      inAppEnabled: true,
      roundNotifications: true,
      payoutNotifications: true,
      eliminationNotifications: true,
      arenaAnnouncementNotifications: true,
    })),
    updatePreferences: jest.fn(async (_userId: string, updates: any) => ({
      userId: "user-1",
      emailEnabled: false,
      pushEnabled: true,
      telegramEnabled: false,
      discordEnabled: false,
      inAppEnabled: true,
      roundNotifications: true,
      payoutNotifications: true,
      eliminationNotifications: true,
      arenaAnnouncementNotifications: true,
      ...updates,
    })),
    getChannelPreferences: jest.fn(async () => []),
    updateChannelPreferences: jest.fn(async () => [
      { eventType: "payout", channel: "telegram", enabled: false },
    ]),
  };
  const links = {
    listLinks: jest.fn(async () => []),
    createCode: jest.fn(async () => ({
      code: "ABC12345",
      expiresAt: new Date("2026-11-20T12:10:00.000Z"),
    })),
    unlink: jest.fn(async () => true),
  };
  const telegram = {
    verifyWebhookSecret: jest.fn(() => true),
    processUpdate: jest.fn(async () => ({ handled: true, linked: true })),
  };
  const discord = {
    verifyInteractionSignature: jest.fn(() => true),
    handleInteraction: jest.fn(async () => ({ type: 1 })),
  };
  const webhook = {
    createWebhook: jest.fn(async () => ({
      id: "webhook-1",
      arenaId: "arena-1",
      name: null,
      urlMasked: "https://example.com/…",
      active: true,
      createdAt: new Date("2026-11-20T12:00:00.000Z"),
    })),
    listWebhooks: jest.fn(async () => []),
    deleteWebhook: jest.fn(async () => true),
  };
  const pipeline = {
    dispatch: jest.fn(async () => ({ delivered: 1, failed: 0, retrying: 0, skipped: 0 })),
    processDueRetries: jest.fn(async () => ({ delivered: 2, failed: 0, retrying: 0, skipped: 0 })),
  };
  const deps = {
    prefs,
    bundle: { links },
    telegram,
    discord,
    webhook,
    pipeline,
  };
  return { prefs, links, telegram, discord, webhook, pipeline, deps };
}

function makeApp(deps: any, options: { host?: boolean; admin?: boolean } = {}) {
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = {
      id: "user-1",
      walletAddress: options.host === false ? "GOTHER" : "GHOST",
      jti: "jti-1",
    };
    next();
  };
  const admin = (_req: Request, _res: Response, next: NextFunction) => next();

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use("/api/users", createNotificationChannelsRouter(auth, deps));
  app.use("/api/notifications", createNotificationBotWebhooksRouter(deps));
  app.use("/api/arenas", createCommunityWebhooksRouter(auth, deps));
  app.use("/api/notifications", createNotificationOpsRouter(admin, deps));
  app.use(errorHandler);
  return app;
}

describe("notification channel routes (#1735)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.arena.findUnique as jest.Mock).mockResolvedValue({
      id: "arena-1",
      metadata: { createdBy: "GHOST" },
    });
  });

  it("returns channel preferences, granular overrides and linked destinations", async () => {
    const mocks = makeMocks();
    const response = await request(makeApp(mocks.deps)).get("/api/users/me/notification-channels");

    expect(response.status).toBe(200);
    expect(response.body.preferences.userId).toBe("user-1");
    expect(response.body.channelPreferences).toEqual([]);
    expect(response.body.links).toEqual([]);
  });

  it("updates per-event/per-channel preferences", async () => {
    const mocks = makeMocks();
    const response = await request(makeApp(mocks.deps))
      .put("/api/users/me/notification-channels")
      .send({ channelPreferences: [{ eventType: "payout", channel: "telegram", enabled: false }] });

    expect(response.status).toBe(200);
    expect(mocks.prefs.updateChannelPreferences).toHaveBeenCalledWith("user-1", [
      { eventType: "payout", channel: "telegram", enabled: false },
    ]);
    expect(response.body.channelPreferences[0].enabled).toBe(false);
  });

  it("issues a one-time bot link code with setup instructions", async () => {
    const mocks = makeMocks();
    const response = await request(makeApp(mocks.deps)).post(
      "/api/users/me/notification-links/telegram/code",
    );

    expect(response.status).toBe(201);
    expect(response.body.code).toBe("ABC12345");
    expect(response.body.instructions).toContain("/start ABC12345");
    expect(mocks.links.createCode).toHaveBeenCalledWith("user-1", "telegram");
  });

  it("authenticates Telegram updates and handles signed Discord interactions", async () => {
    const mocks = makeMocks();
    const app = makeApp(mocks.deps);

    expect((await request(app).post("/api/notifications/telegram").send({ message: {} })).status).toBe(
      200,
    );
    expect(mocks.telegram.processUpdate).toHaveBeenCalled();

    mocks.telegram.verifyWebhookSecret.mockReturnValue(false);
    const rejected = await request(app).post("/api/notifications/telegram").send({ message: {} });
    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe("INVALID_WEBHOOK_SECRET");

    const discord = await request(app)
      .post("/api/notifications/discord")
      .set("x-signature-ed25519", "signature")
      .set("x-signature-timestamp", "1763640000")
      .send({ type: 1 });
    expect(discord.status).toBe(200);
    expect(mocks.discord.verifyInteractionSignature).toHaveBeenCalledWith(
      expect.any(Buffer),
      "signature",
      "1763640000",
    );
    expect(mocks.discord.handleInteraction).toHaveBeenCalledWith({ type: 1 });
  });

  it("restricts community webhooks to the arena host and dispatches announcements", async () => {
    const mocks = makeMocks();
    const app = makeApp(mocks.deps);

    const created = await request(app)
      .post("/api/arenas/arena-1/notification-webhooks")
      .send({ url: "https://discord.com/api/webhooks/123/abc", name: "Community" });
    expect(created.status).toBe(201);
    expect(mocks.webhook.createWebhook).toHaveBeenCalledWith(
      "arena-1",
      "user-1",
      "https://discord.com/api/webhooks/123/abc",
      "Community",
    );

    const announced = await request(app)
      .post("/api/arenas/arena-1/announcements")
      .send({ title: "Round 3 is live" });
    expect(announced.status).toBe(202);
    expect(mocks.pipeline.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "arena_announcement",
        arenaId: "arena-1",
        userIds: ["user-1"],
        message: expect.objectContaining({ title: "Round 3 is live" }),
      }),
    );

    const forbidden = await request(makeApp(mocks.deps, { host: false }))
      .post("/api/arenas/arena-1/notification-webhooks")
      .send({ url: "https://discord.com/api/webhooks/123/abc" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
  });

  it("exposes the admin retry runner", async () => {
    const mocks = makeMocks();
    const response = await request(makeApp(mocks.deps)).post("/api/notifications/retries/run");

    expect(response.status).toBe(200);
    expect(response.body.delivered).toBe(2);
    expect(mocks.pipeline.processDueRetries).toHaveBeenCalled();
  });
});
