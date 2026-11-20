import type { PrismaClient } from "@prisma/client";
import type { NotificationChannel, NotificationChannelType } from "../notificationChannel";
import type { NotificationPreferencesService } from "../notificationPreferencesService";
import { NotificationLinkService } from "../notificationLinkService";
import { PushService } from "../pushService";
import { DiscordChannel } from "./discordChannel";
import { PushChannel } from "./pushChannel";
import { TelegramChannel } from "./telegramChannel";
import { WebhookChannel } from "./webhookChannel";

export interface NotificationChannelBundle {
  channels: Partial<Record<NotificationChannelType, NotificationChannel>>;
  links: NotificationLinkService;
  push: PushService;
  telegram: TelegramChannel;
  discord: DiscordChannel;
  webhook: WebhookChannel;
}

/**
 * Build the production channel registry. Platform credentials are read once
 * from env; adapters with no configured token report `skipped` rather than
 * throwing, so a partial deployment still delivers on its configured channels.
 */
export function createNotificationChannels(
  prisma: PrismaClient,
  prefs: NotificationPreferencesService,
): NotificationChannelBundle {
  const links = new NotificationLinkService(prisma);
  const push = new PushService(prisma, prefs);
  const telegram = new TelegramChannel({ linkService: links });
  const discord = new DiscordChannel({ linkService: links });
  const webhook = new WebhookChannel(prisma);

  return {
    channels: {
      push: new PushChannel(push),
      telegram,
      discord,
      webhook,
    },
    links,
    push,
    telegram,
    discord,
    webhook,
  };
}
