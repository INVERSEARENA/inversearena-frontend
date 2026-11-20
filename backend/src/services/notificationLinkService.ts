import { createHmac, randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import type { NotificationChannelType } from "./notificationChannel";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
const CODE_LENGTH = 10;

export type LinkableChannel = Extract<NotificationChannelType, "telegram" | "discord">;

export class NotificationLinkError extends Error {
  constructor(readonly code: "INVALID_CODE" | "ALREADY_LINKED" | "NOT_LINKED") {
    super(code);
    this.name = "NotificationLinkError";
  }
}

export interface LinkView {
  id: string;
  channel: LinkableChannel;
  externalId: string;
  displayName: string | null;
  active: boolean;
  linkedAt: Date;
}

export interface NotificationLinkServiceDeps {
  now?: () => Date;
  ttlMs?: number;
  secret?: string;
}

/**
 * One-time bot link codes (#1735).
 *
 * Codes are shown to the user once, stored only as an HMAC digest, expire
 * quickly, and can be redeemed a single time. The bot supplies the platform
 * user/chat id; the wallet identity comes from the authenticated code owner,
 * so a bot cannot link an arbitrary account.
 */
export class NotificationLinkService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly secret: string;

  constructor(private prisma: PrismaClient, deps: NotificationLinkServiceDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? 10 * 60 * 1000;
    this.secret = deps.secret ?? env.JWT_SECRET ?? "notification-link-development-secret";
  }

  private hash(code: string): string {
    return createHmac("sha256", this.secret).update(code.toUpperCase()).digest("hex");
  }

  private generateCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let code = "";
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return code;
  }

  private assertLinkable(channel: string): LinkableChannel {
    if (channel !== "telegram" && channel !== "discord") {
      throw new Error(`Channel ${channel} does not use one-time link codes`);
    }
    return channel;
  }

  async createCode(
    userId: string,
    channel: LinkableChannel,
  ): Promise<{ code: string; expiresAt: Date }> {
    const code = this.generateCode();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs);
    await this.prisma.notificationLinkCode.create({
      data: {
        userId,
        channel,
        codeHash: this.hash(code),
        expiresAt,
      },
    });
    return { code, expiresAt };
  }

  async consumeCode(
    channel: LinkableChannel,
    rawCode: string,
    externalId: string,
    details: { displayName?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<{ userId: string; link: LinkView }> {
    const linkable = this.assertLinkable(channel);
    const code = rawCode.trim().toUpperCase().replace(/^@?[A-Z0-9_]+$/g, (match) => match);
    const record = await this.prisma.notificationLinkCode.findFirst({
      where: {
        channel: linkable,
        codeHash: this.hash(code),
        usedAt: null,
        expiresAt: { gt: this.now() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!record) throw new NotificationLinkError("INVALID_CODE");

    // Redeem before creating the link so two bot webhooks cannot both claim
    // the same code concurrently.
    const redeemed = await this.prisma.notificationLinkCode.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: this.now() },
    });
    if ( redeemed.count !== 1) throw new NotificationLinkError("INVALID_CODE");

    try {
      const link = await this.prisma.notificationChannelLink.upsert({
        where: { userId_channel: { userId: record.userId, channel: linkable } },
        create: {
          userId: record.userId,
          channel: linkable,
          externalId,
          displayName: details.displayName ?? null,
          ...(details.metadata ? { metadata: details.metadata as any } : {}),
          active: true,
        },
        update: {
          externalId,
          displayName: details.displayName ?? null,
          ...(details.metadata ? { metadata: details.metadata as any } : {}),
          active: true,
        },
        select: {
          id: true,
          channel: true,
          externalId: true,
          displayName: true,
          active: true,
          createdAt: true,
        },
      });
      return { userId: record.userId, link: this.toLinkView(link) };
    } catch (err) {
      void err;
      throw new NotificationLinkError("ALREADY_LINKED");
    }
  }

  private toLinkView(link: {
    id: string;
    channel: string;
    externalId: string;
    displayName: string | null;
    active: boolean;
    createdAt: Date;
  }): LinkView {
    return {
      id: link.id,
      channel: this.assertLinkable(link.channel),
      externalId: link.externalId,
      displayName: link.displayName,
      active: link.active,
      linkedAt: link.createdAt,
    };
  }

  async listLinks(userId: string): Promise<LinkView[]> {
    const links = await this.prisma.notificationChannelLink.findMany({
      where: { userId },
      select: {
        id: true,
        channel: true,
        externalId: true,
        displayName: true,
        active: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return links.map((link) => this.toLinkView(link));
  }

  async getActiveLink(userId: string, channel: LinkableChannel) {
    return this.prisma.notificationChannelLink.findFirst({
      where: { userId, channel, active: true },
      select: {
        id: true,
        userId: true,
        channel: true,
        externalId: true,
        displayName: true,
        metadata: true,
        active: true,
      },
    });
  }

  async unlink(userId: string, channel: LinkableChannel): Promise<boolean> {
    const result = await this.prisma.notificationChannelLink.deleteMany({ where: { userId, channel } });
    return result.count > 0;
  }

  /** Called when a bot is blocked/removed or a platform reports a dead chat. */
  async deactivateByExternalId(channel: LinkableChannel, externalId: string): Promise<void> {
    await this.prisma.notificationChannelLink.updateMany({
      where: { channel, externalId },
      data: { active: false },
    });
  }

  async updateMetadata(userId: string, channel: LinkableChannel, metadata: Record<string, unknown>) {
    await this.prisma.notificationChannelLink.updateMany({
      where: { userId, channel },
      data: { metadata: metadata as any },
    });
  }
}
