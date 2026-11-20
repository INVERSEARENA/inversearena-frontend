import type { PrismaClient } from "@prisma/client";
import {
  formatNotificationText,
  type ChannelSendResult,
  type NotificationChannel,
  type NotificationDeliveryContext,
  type NotificationMessage,
} from "../notificationChannel";
import { NotificationCrypto } from "../notificationCrypto";

type Sender = (url: string, init: RequestInit) => Promise<Response>;

export interface WebhookChannelDeps {
  sender?: Sender;
  crypto?: NotificationCrypto;
}

export interface WebhookView {
  id: string;
  arenaId: string;
  name: string | null;
  urlMasked: string;
  active: boolean;
  createdAt: Date;
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/[^/]*$/, "/…")}`;
  } catch {
    return "invalid-url";
  }
}

function assertHttpsUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Webhook URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Webhook URL must use https");
  if (value.length > 2000) throw new Error("Webhook URL is too long");
}

/**
 * Community webhook adapter (#1735). Hosts register one HTTPS webhook per
 * arena; arena announcements are POSTed as rich JSON. URLs are encrypted at
 * rest because possession of the URL is delivery authority.
 */
export class WebhookChannel implements NotificationChannel {
  readonly channel = "webhook" as const;
  private readonly sender: Sender;
  private readonly crypto: NotificationCrypto;

  constructor(private prisma: PrismaClient, deps: WebhookChannelDeps = {}) {
    this.sender = deps.sender ?? ((url, init) => fetch(url, init));
    this.crypto = deps.crypto ?? new NotificationCrypto();
  }

  async createWebhook(
    arenaId: string,
    createdBy: string,
    url: string,
    name?: string,
  ): Promise<WebhookView> {
    assertHttpsUrl(url);
    const record = await this.prisma.arenaNotificationWebhook.create({
      data: {
        arenaId,
        createdBy,
        url: this.crypto.encrypt(url),
        ...(name ? { name: name.slice(0, 120) } : {}),
      },
      select: { id: true, arenaId: true, name: true, url: true, active: true, createdAt: true },
    });
    return {
      id: record.id,
      arenaId: record.arenaId,
      name: record.name,
      urlMasked: maskUrl(url),
      active: record.active,
      createdAt: record.createdAt,
    };
  }

  async listWebhooks(arenaId: string): Promise<WebhookView[]> {
    const rows = await this.prisma.arenaNotificationWebhook.findMany({
      where: { arenaId },
      select: { id: true, arenaId: true, name: true, url: true, active: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => {
      let masked = "invalid-url";
      try {
        masked = maskUrl(this.crypto.decrypt(row.url));
      } catch {
        // Keep the record visible even if the storage key rotated away.
      }
      return {
        id: row.id,
        arenaId: row.arenaId,
        name: row.name,
        urlMasked: masked,
        active: row.active,
        createdAt: row.createdAt,
      };
    });
  }

  async deleteWebhook(arenaId: string, webhookId: string, userId: string): Promise<boolean> {
    const result = await this.prisma.arenaNotificationWebhook.deleteMany({
      where: { id: webhookId, arenaId, createdBy: userId },
    });
    return result.count > 0;
  }

  async send(
    _userId: string,
    message: NotificationMessage,
    context: NotificationDeliveryContext,
  ): Promise<ChannelSendResult> {
    if (!context.arenaId) return { status: "skipped", error: "arena webhook requires arenaId" };
    const webhooks = await this.prisma.arenaNotificationWebhook.findMany({
      where: { arenaId: context.arenaId, active: true },
      select: { id: true, url: true },
    });
    if (webhooks.length === 0) return { status: "skipped", error: "no community webhooks" };

    let delivered = 0;
    let retryable = 0;
    let errors: string[] = [];
    for (const webhook of webhooks) {
      try {
        const url = this.crypto.decrypt(webhook.url);
        assertHttpsUrl(url);
        const response = await this.sender(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "InverseArena-Notifications/1.0",
          },
          body: JSON.stringify({
            eventType: context.eventType,
            arenaId: context.arenaId,
            title: message.title,
            body: message.body,
            text: formatNotificationText(message),
            url: message.url,
            ...(message.tag ? { tag: message.tag } : {}),
            timestamp: new Date().toISOString(),
          }),
        });
        if (response.ok) {
          delivered += 1;
          continue;
        }
        const error = `Webhook ${webhook.id} responded with status ${response.status}`;
        errors.push(error);
        if (response.status === 429 || response.status >= 500) {
          retryable += 1;
        } else {
          await this.prisma.arenaNotificationWebhook
            .update({ where: { id: webhook.id }, data: { active: false } })
            .catch(() => {});
        }
      } catch (err) {
        retryable += 1;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (delivered > 0) return { status: "delivered" };
    if (retryable > 0) return { status: "retryable", error: errors.join("; ") };
    return { status: "failed", error: errors.join("; ") || "all webhooks failed" };
  }
}
