/**
 * Notification channel routes (#1735).
 *
 * - wallet-authenticated link-code creation, unlinking and granular prefs
 * - signed inbound Telegram/Discord bot callbacks
 * - host-managed community webhooks and arena announcements
 * - admin-triggered retry queue processing
 */

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { apiError } from "../utils/apiError";
import { boundedString } from "../validation/payloadLimits";
import { NotificationPreferencesService } from "../services/notificationPreferencesService";
import { NotificationPipelineService } from "../services/notificationPipelineService";
import { createNotificationChannels, type NotificationChannelBundle } from "../services/channels";
import type { DiscordChannel } from "../services/channels/discordChannel";
import type { TelegramChannel } from "../services/channels/telegramChannel";
import type { WebhookChannel } from "../services/channels/webhookChannel";

const LinkableChannelSchema = z.enum(["telegram", "discord"]);

const ChannelPreferenceSchema = z.object({
  eventType: z.enum(["round", "payout", "elimination", "rematch", "arena_announcement"]),
  channel: z.enum(["push", "telegram", "discord", "webhook", "email", "in_app"]),
  enabled: z.boolean(),
});

const UpdateChannelSettingsSchema = z.object({
  pushEnabled: z.boolean().optional(),
  telegramEnabled: z.boolean().optional(),
  discordEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  roundNotifications: z.boolean().optional(),
  payoutNotifications: z.boolean().optional(),
  eliminationNotifications: z.boolean().optional(),
  arenaAnnouncementNotifications: z.boolean().optional(),
  channelPreferences: z.array(ChannelPreferenceSchema).max(30).optional(),
});

const AnnouncementSchema = z.object({
  title: boundedString(120).optional(),
  body: boundedString(1000).optional(),
  url: z.string().url().max(2000).optional(),
});

const WebhookSchema = z.object({
  url: z.string().url().max(2000),
  name: boundedString(120).optional(),
});

interface RouteDeps {
  bundle?: NotificationChannelBundle;
  prefs?: NotificationPreferencesService;
  pipeline?: NotificationPipelineService;
  telegram?: TelegramChannel;
  discord?: DiscordChannel;
  webhook?: WebhookChannel;
}

interface ResolvedDeps {
  bundle: NotificationChannelBundle;
  prefs: NotificationPreferencesService;
  pipeline: NotificationPipelineService;
  telegram: TelegramChannel;
  discord: DiscordChannel;
  webhook: WebhookChannel;
}

function resolveDeps(deps: RouteDeps = {}): ResolvedDeps {
  const prefs = deps.prefs ?? new NotificationPreferencesService(prisma);
  const bundle = deps.bundle ?? createNotificationChannels(prisma, prefs);
  return {
    bundle,
    prefs,
    pipeline:
      deps.pipeline ??
      new NotificationPipelineService({ prefs, channels: bundle.channels }),
    telegram: deps.telegram ?? bundle.telegram,
    discord: deps.discord ?? bundle.discord,
    webhook: deps.webhook ?? bundle.webhook,
  };
}

function currentUserId(req: { user?: { id?: string } }): string {
  const userId = req.user?.id;
  if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");
  return userId;
}

/** Wallet-authenticated channel preferences and link management. */
export function createNotificationChannelsRouter(
  authMiddleware: RequestHandler,
  deps: RouteDeps = {},
): Router {
  const router = Router();
  const services = resolveDeps(deps);

  router.get(
    "/me/notification-channels",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const [preferences, channelPreferences, links] = await Promise.all([
        services.prefs.getPreferences(userId),
        services.prefs.getChannelPreferences(userId),
        services.bundle.links.listLinks(userId),
      ]);
      res.json({ preferences, channelPreferences, links });
    }),
  );

  router.put(
    "/me/notification-channels",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const updates = UpdateChannelSettingsSchema.parse(req.body);
      const { channelPreferences, ...preferenceUpdates } = updates;
      const [preferences, granular] = await Promise.all([
        services.prefs.updatePreferences(userId, preferenceUpdates as any),
        channelPreferences
          ? services.prefs.updateChannelPreferences(userId, channelPreferences)
          : services.prefs.getChannelPreferences(userId),
      ]);
      res.json({ preferences, channelPreferences: granular });
    }),
  );

  router.post(
    "/me/notification-links/:channel/code",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const channel = LinkableChannelSchema.parse(req.params.channel);
      const { code, expiresAt } = await services.bundle.links.createCode(userId, channel);
      res.status(201).json({
        channel,
        code,
        expiresAt: expiresAt.toISOString(),
        instructions:
          channel === "telegram"
            ? `Send /start ${code} to the InverseArena Telegram bot.`
            : `Run /link ${code} in Discord (DM or server where the bot is installed).`,
      });
    }),
  );

  router.delete(
    "/me/notification-links/:channel",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const channel = LinkableChannelSchema.parse(req.params.channel);
      const removed = await services.bundle.links.unlink(userId, channel);
      await services.prefs.updatePreferences(userId, {
        ...(channel === "telegram" ? { telegramEnabled: false } : { discordEnabled: false }),
      });
      res.json({ success: removed, channel });
    }),
  );

  return router;
}

/** Inbound bot callbacks. Mounted behind the raw-body JSON parser in app.ts. */
export function createNotificationBotWebhooksRouter(deps: RouteDeps = {}): Router {
  const router = Router();
  const services = resolveDeps(deps);

  router.post(
    "/telegram",
    asyncHandler(async (req, res) => {
      if (!services.telegram.verifyWebhookSecret(req.headers["x-telegram-bot-api-secret-token"] as string | undefined)) {
        throw apiError(401, "INVALID_WEBHOOK_SECRET", "Invalid Telegram webhook secret");
      }
      const result = await services.telegram.processUpdate(req.body);
      res.json({ ok: true, ...result });
    }),
  );

  router.post(
    "/discord",
    asyncHandler(async (req, res) => {
      const rawBody = (req as { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        throw apiError(400, "RAW_BODY_MISSING", "Raw Discord interaction body is required");
      }
      const valid = services.discord.verifyInteractionSignature(
        rawBody,
        req.headers["x-signature-ed25519"] as string | undefined,
        req.headers["x-signature-timestamp"] as string | undefined,
      );
      if (!valid) {
        throw apiError(401, "INVALID_INTERACTION_SIGNATURE", "Invalid Discord interaction signature");
      }
      res.json(await services.discord.handleInteraction(req.body));
    }),
  );

  return router;
}

/** Host-managed community webhooks and arena announcements. */
export function createCommunityWebhooksRouter(
  authMiddleware: RequestHandler,
  deps: RouteDeps = {},
): Router {
  const router = Router();
  const services = resolveDeps(deps);

  async function assertHost(arenaId: string, walletAddress: string): Promise<void> {
    const arena = await prisma.arena.findUnique({ where: { id: arenaId } });
    if (!arena) throw apiError(404, "ARENA_NOT_FOUND", "Arena not found");
    const createdBy = (arena.metadata as Record<string, unknown> | null)?.createdBy;
    if (createdBy !== walletAddress) {
      throw apiError(403, "FORBIDDEN", "Only the arena host may manage notification webhooks");
    }
  }

  router.post(
    "/:arenaId/notification-webhooks",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const walletAddress = req.user?.walletAddress;
      if (!walletAddress) throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      await assertHost(req.params.arenaId!, walletAddress);
      const body = WebhookSchema.parse(req.body);
      const webhook = await services.webhook.createWebhook(
        req.params.arenaId!,
        currentUserId(req),
        body.url,
        body.name,
      );
      res.status(201).json(webhook);
    }),
  );

  router.get(
    "/:arenaId/notification-webhooks",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const walletAddress = req.user?.walletAddress;
      if (!walletAddress) throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      await assertHost(req.params.arenaId!, walletAddress);
      res.json({ items: await services.webhook.listWebhooks(req.params.arenaId!) });
    }),
  );

  router.delete(
    "/:arenaId/notification-webhooks/:webhookId",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const walletAddress = req.user?.walletAddress;
      if (!walletAddress) throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      await assertHost(req.params.arenaId!, walletAddress);
      const removed = await services.webhook.deleteWebhook(
        req.params.arenaId!,
        req.params.webhookId!,
        currentUserId(req),
      );
      if (!removed) throw apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
      res.json({ success: true });
    }),
  );

  router.post(
    "/:arenaId/announcements",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const walletAddress = req.user?.walletAddress;
      if (!walletAddress) throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      await assertHost(req.params.arenaId!, walletAddress);
      const body = AnnouncementSchema.parse(req.body);
      const arenaId = req.params.arenaId!;
      const result = await services.pipeline.dispatch({
        eventType: "arena_announcement",
        dedupeKey: `arena-announcement:${arenaId}:${Date.now()}`,
        arenaId,
        userIds: [currentUserId(req)],
        message: {
          title: body.title ?? "Arena announcement",
          body: body.body ?? "The host has an update for this arena.",
          url: body.url ?? `/arena/${arenaId}`,
        },
      });
      res.status(202).json(result);
    }),
  );

  return router;
}

/** Admin-controlled retry queue runner. */
export function createNotificationOpsRouter(
  adminAuthMiddleware: RequestHandler,
  deps: RouteDeps = {},
): Router {
  const router = Router();
  const services = resolveDeps(deps);

  router.post(
    "/retries/run",
    adminAuthMiddleware,
    asyncHandler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      res.json(await services.pipeline.processDueRetries(limit));
    }),
  );

  return router;
}

export type { RouteDeps as NotificationRouteDeps };
