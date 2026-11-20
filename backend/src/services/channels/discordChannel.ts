import { createPublicKey, timingSafeEqual, verify as verifyEd25519 } from "crypto";
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

export interface DiscordChannelDeps {
  token?: string;
  publicKey?: string;
  apiBaseUrl?: string;
  sender?: Sender;
  now?: () => number;
  linkService?: NotificationLinkService;
}

export interface DiscordInteractionResponse {
  type: number;
  data?: { content: string; flags?: number };
}

interface DiscordApiError {
  retry_after?: number;
  message?: string;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Discord adapter (#1735).
 *
 * Linking uses the `/link CODE` application command: Discord signatures are
 * verified over the exact raw body, the one-time code proves wallet
 * ownership, and only the Discord user id (plus a DM channel id) is stored.
 */
export class DiscordChannel implements NotificationChannel {
  readonly channel = "discord" as const;
  private readonly token: string | undefined;
  private readonly publicKey: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly sender: Sender;
  private readonly now: () => number;
  private readonly linkService: NotificationLinkService | undefined;

  constructor(deps: DiscordChannelDeps = {}) {
    this.token = deps.token ?? env.DISCORD_BOT_TOKEN;
    this.publicKey = deps.publicKey ?? env.DISCORD_PUBLIC_KEY;
    this.apiBaseUrl = (deps.apiBaseUrl ?? "https://discord.com/api/v10").replace(/\/$/, "");
    this.sender = deps.sender ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => Date.now());
    this.linkService = deps.linkService;
  }

  private requireLinkService(): NotificationLinkService {
    if (!this.linkService) throw new Error("Discord link service is not configured");
    return this.linkService;
  }

  private async apiRequest(
    path: string,
    init: RequestInit,
  ): Promise<{ response: Response; data: any }> {
    const token = this.token;
    if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
    const response = await this.sender(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    let data: any = {};
    try {
      data = await response.json();
    } catch {
      // Treat non-JSON gateway errors as transient below.
    }
    return { response, data };
  }

  async send(
    userId: string,
    message: NotificationMessage,
    _context: NotificationDeliveryContext,
  ): Promise<ChannelSendResult> {
    if (!this.token) return { status: "skipped", error: "DISCORD_BOT_TOKEN is not configured" };
    const link = await this.requireLinkService().getActiveLink(userId, "discord");
    if (!link) return { status: "skipped", error: "discord not linked" };

    try {
      let dmChannelId =
        link.metadata && typeof link.metadata === "object" && !Array.isArray(link.metadata)
          ? (link.metadata as Record<string, unknown>).dmChannelId
          : undefined;
      if (typeof dmChannelId !== "string" || dmChannelId.length === 0) {
        const dm = await this.apiRequest("/users/@me/channels", {
          method: "POST",
          body: JSON.stringify({ recipient_id: link.externalId }),
        });
        if (!dm.response.ok || typeof dm.data?.id !== "string") {
          return this.classifyError(dm.response, dm.data);
        }
        dmChannelId = dm.data.id;
        await this.requireLinkService().updateMetadata(userId, "discord", { dmChannelId });
      }

      const sent = await this.apiRequest(`/channels/${dmChannelId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: formatNotificationText(message),
          embeds: [
            {
              title: message.title,
              description: message.body,
              ...(message.url ? { url: message.url } : {}),
            },
          ],
        }),
      });
      if (sent.response.ok) return { status: "delivered" };
      return this.classifyError(sent.response, sent.data);
    } catch (err) {
      return { status: "retryable", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private classifyError(response: Response, data: DiscordApiError | undefined): ChannelSendResult {
    const error = data?.message ?? `Discord responded with status ${response.status}`;
    if (response.status === 429 || response.status >= 500) {
      return {
        status: "retryable",
        error,
        ...(typeof data?.retry_after === "number"
          ? { retryAfterMs: Math.ceil(data.retry_after * 1000) }
          : {}),
      };
    }
    return { status: "failed", error };
  }

  /**
   * Verify Discord's Ed25519 `x-signature-ed25519` over
   * `timestamp + rawBody` and reject stale replays.
   */
  verifyInteractionSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined,
  ): boolean {
    if (!this.publicKey || !signatureHeader || !timestampHeader) return false;
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp) || Math.abs(this.now() - timestamp * 1000) > FIVE_MINUTES_MS) {
      return false;
    }
    try {
      const der = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(this.publicKey, "hex"),
      ]);
      const key = createPublicKey({ key: der, format: "der", type: "spki" });
      const signature = Buffer.from(signatureHeader, "hex");
      return signature.length === 64 && verifyEd25519(null, Buffer.concat([Buffer.from(timestampHeader), rawBody]), key, signature);
    } catch {
      return false;
    }
  }

  /** Constant-time check for the optional bot-command shared secret. */
  verifyCommandSecret(header: string | undefined, expected: string | undefined): boolean {
    if (!expected || !header) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handleInteraction(body: any): Promise<DiscordInteractionResponse> {
    if (body?.type === 1) return { type: 1 };
    if (body?.type !== 2 || body?.data?.name !== "link") {
      return { type: 4, data: { content: "Unknown command.", flags: 64 } };
    }
    const code = String(body.data.options?.find?.((o: any) => o.name === "code")?.value ?? "").trim();
    if (!code) {
      return { type: 4, data: { content: "Usage: `/link YOUR_CODE`", flags: 64 } };
    }
    const user = body.member?.user ?? body.user;
    const externalId = String(user?.id ?? "");
    if (!externalId) {
      return { type: 4, data: { content: "Unable to identify your Discord account.", flags: 64 } };
    }
    try {
      await this.requireLinkService().consumeCode("discord", code, externalId, {
        displayName: user?.username ?? user?.global_name ?? undefined,
      });
      return {
        type: 4,
        data: {
          content: "✅ InverseArena alerts are now linked to this Discord account.",
          flags: 64,
        },
      };
    } catch (err) {
      if (err instanceof NotificationLinkError) {
        const message =
          err.code === "ALREADY_LINKED"
            ? "That Discord account is linked to another wallet."
            : "This code is invalid or has expired. Generate a new one in InverseArena.";
        return { type: 4, data: { content: message, flags: 64 } };
      }
      throw err;
    }
  }
}
