import { prisma } from "../db/prisma";
import type { ArenaMessage, MessageReport } from "@prisma/client";
import { RateLimiter } from "../utils/rateLimiter";

const MESSAGE_RATE_LIMIT = 10; // messages per minute
const MESSAGE_MAX_LENGTH = 200;
const REACTION_MAX_LENGTH = 2; // emoji length

const messageLimiters = new Map<string, RateLimiter>();

export class ArenaMessageService {
  private getProfanityFilter(): (text: string) => string {
    // Simple profanity list - can be expanded
    const profanityList = ["badword1", "badword2"];
    return (text: string) => {
      let filtered = text;
      profanityList.forEach((word) => {
        const regex = new RegExp(word, "gi");
        filtered = filtered.replace(regex, "*".repeat(word.length));
      });
      return filtered;
    };
  }

  private getRateLimiter(userId: string): RateLimiter {
    if (!messageLimiters.has(userId)) {
      messageLimiters.set(userId, new RateLimiter(MESSAGE_RATE_LIMIT, 60000)); // 60 seconds
    }
    return messageLimiters.get(userId)!;
  }

  async postMessage(
    arenaId: string,
    userId: string,
    content: string,
    messageType: "chat" | "reaction" = "chat",
  ): Promise<ArenaMessage | null> {
    // Rate limiting
    const limiter = this.getRateLimiter(userId);
    if (!limiter.tryConsume(1)) {
      throw new Error("Rate limit exceeded");
    }

    // Validation
    const maxLength = messageType === "reaction" ? REACTION_MAX_LENGTH : MESSAGE_MAX_LENGTH;
    if (content.length > maxLength) {
      throw new Error(`Message exceeds maximum length of ${maxLength}`);
    }

    // Profanity filtering
    const filter = this.getProfanityFilter();
    const filteredContent = messageType === "chat" ? filter(content) : content;

    return prisma.arenaMessage.create({
      data: {
        arenaId,
        userId,
        content: filteredContent,
        messageType,
        status: "active",
      },
    });
  }

  async getArenaMessages(
    arenaId: string,
    limit: number = 50,
  ): Promise<ArenaMessage[]> {
    return prisma.arenaMessage.findMany({
      where: {
        arenaId,
        status: { in: ["active"] },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async muteMessage(messageId: string): Promise<ArenaMessage> {
    return prisma.arenaMessage.update({
      where: { id: messageId },
      data: { status: "muted" },
    });
  }

  async reportMessage(
    messageId: string,
    reporterId: string,
    reason: string,
  ): Promise<MessageReport> {
    // Increment report count
    await prisma.arenaMessage.update({
      where: { id: messageId },
      data: { reportCount: { increment: 1 } },
    });

    return prisma.messageReport.create({
      data: {
        messageId,
        reporterId,
        reason,
        status: "pending",
      },
    });
  }

  async getMessageReports(
    limit: number = 50,
    offset: number = 0,
  ): Promise<MessageReport[]> {
    return prisma.messageReport.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    });
  }

  async reviewReport(
    reportId: string,
    action: "dismiss" | "mute",
    messageId?: string,
  ): Promise<MessageReport> {
    const report = await prisma.messageReport.update({
      where: { id: reportId },
      data: { status: action === "dismiss" ? "dismissed" : "reviewed" },
    });

    if (action === "mute" && messageId) {
      await this.muteMessage(messageId);
    }

    return report;
  }

  async disableForCommitWindow(
    arenaId: string,
    duration: number = 300000, // 5 minutes
  ): Promise<void> {
    // Mark arena messages as temporarily read-only during commit window
    // This is handled at the route level - messages can still be fetched but not posted
  }
}

export const arenaMessageService = new ArenaMessageService();
