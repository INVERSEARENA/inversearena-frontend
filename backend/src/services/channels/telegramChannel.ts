import { timingSafeEqual } from "crypto";
import { env } from "../../config/env";
import {
  formatNotificationText,
  type ChannelSendResult,
  type NotificationChannel,
  type NotificationDeliveryContext,
  type NotificationMessage,
} from "../notificationChannel";
import { NotificationLinkError, NotificationLinkService } from "../notificationLinkService";

type Sender = (url: string, init: RequestInit) => Promise<Response>;

export interface TelegramChannelDeps {
  token?: string;
  apiBaseUrl?: string;
  sender?: Sender;
  webhookSecret?: string;
  linkService?: NotificationLinkService;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
}

/**
 * Telegram Bot API adapter (#1735).
 *
 * Links use a one-time code from the wallet owner sent as `/start CODE` to
 * the bot. The bot token stays in env; only the chat id is persisted. A
 * blocked/removed bot deactivates the link so the pipeline stops retrying.
 */
export class TelegramChannel implements NotificationChannel {
  readonly channel = "telegram" as const;
  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly sender: Sender;
  private readonly webhookSecret: string | undefined;
  private readonly linkService: NotificationLinkService | undefined;

  constructor(deps: TelegramChannelDeps = {}) {
    this.token = deps.token ?? env.TELEGRAM_BOT_TOKEN;
    this.apiBaseUrl = (deps.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.sender = deps.sender ?? ((url, init) => fetch(url, init));
    this.webhookSecret = deps.webhookSecret ?? env.TELEGRAM_WEBHOOK_SECRET;
    this.linkService = deps.linkService;
  }

  private requireLinkService(): NotificationLinkService {
    if (!this.linkService) throw new Error("Telegram link service is not configured");
    return this.linkService;
  }

  private async callApi<T extends TelegramApiResponse>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<{ response: Response; data: T }> {
    const token = this.token;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    const response = await this.sender(`${this.apiBaseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {} as T;
    try {
      data = (await response.json()) as T;
    } catch {
      // Telegram normally returns JSON; an HTML gateway error is retryable.
    }
    return { response, data };
  }

  async send(
    userId: string,
    message: NotificationMessage,
    _context: NotificationDeliveryContext,
  ): Promise<ChannelSendResult> {
    if (!this.token) return { status: "skipped", error: "TELEGRAM_BOT_TOKEN is not configured" };
    const link = await this.requireLinkService().getActiveLink(userId, "telegram");
    if (!link) return { status: "skipped", error: "telegram not linked" };

    try {
      const { response, data } = await this.callApi<TelegramApiResponse>("sendMessage", {
        chat_id: link.externalId,
        text: formatNotificationText(message),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      if (response.ok && data.ok !== false) return { status: "delivered" };

      const description = data.description ?? `Telegram responded with status ${response.status}`;
      const retryAfterMs =
        response.status === 429 && typeof data.parameters?.retry_after === "number"
          ? data.parameters.retry_after * 1000
          : undefined;
      if (response.status === 429 || response.status >= 500) {
        return { status: "retryable", error: description, ...(retryAfterMs ? { retryAfterMs } : {}) };
      }
      if (
        response.status === 403 ||
        /bot was blocked|chat not found|user is deactivated|kicked/i.test(description)
      ) {
        await this.requireLinkService().deactivateByExternalId("telegram", link.externalId);
        return { status: "failed", error: description };
      }
      return { status: "failed", error: description };
    } catch (err) {
      return { status: "retryable", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Constant-time check of the `x-telegram-bot-api-secret-token` header. */
  verifyWebhookSecret(header: string | undefined): boolean {
    const expected = this.webhookSecret;
    if (!expected) return false;
    if (!header) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Handle a Telegram update (`/start CODE` and bot block/remove events).
   * Returns whether the update was recognised and acted on.
   */
  async processUpdate(update: any): Promise<{ handled: boolean; linked?: boolean; reason?: string }> {
    const message = update?.message ?? update?.edited_message;
    if (message?.text) {
      const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{4,32})/.exec(message.text.trim());
      if (!match) return { handled: false };
      const chatId = String(message.chat?.id ?? "");
      if (!chatId) return { handled: true, reason: "missing_chat_id" };
      try {
        const result = await this.requireLinkService().consumeCode(
          "telegram",
          match[1]!,
          chatId,
          {
            displayName:
              message.chat?.username ||
              [message.chat?.first_name, message.chat?.last_name].filter(Boolean).join(" ") ||
              undefined,
          },
        );
        void result;
        if (this.token) {
          await this.callApi("sendMessage", {
            chat_id: chatId,
            text: "✅ Your InverseArena account is linked. Round and payout alerts will arrive here.",
          }).catch(() => {});
        }
        return { handled: true, linked: true };
      } catch (err) {
        if (err instanceof NotificationLinkError) {
          return { handled: true, reason: err.code };
        }
        throw err;
      }
    }

    const member = update?.my_chat_member;
    const status = member?.new_chat_member?.status;
    if (member?.chat?.id && (status === "kicked" || status === "left")) {
      await this.requireLinkService().deactivateByExternalId("telegram", String(member.chat.id));
      return { handled: true, linked: false };
    }

    return { handled: false };
  }
}
