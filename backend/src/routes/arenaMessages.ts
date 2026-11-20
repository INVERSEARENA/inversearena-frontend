import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { arenaMessageService } from "../services/arenaMessageService";
import { apiError } from "../utils/apiError";
import type { Request } from "express";

const PostMessageSchema = z.object({
  content: z.string().trim().min(1).max(200),
  messageType: z.enum(["chat", "reaction"]).default("chat"),
});

const GetMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ReportMessageSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

interface AuthRequest extends Request {
  wallet?: string;
}

export function createArenaMessagesRouter(requireAuth: RequestHandler) {
  const router = Router({ mergeParams: true });

  router.post(
    "/:arenaId/messages",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { arenaId } = req.params;
      const { content, messageType } = PostMessageSchema.parse(req.body);
      const userId = req.wallet;

      if (!userId) {
        return apiError(res, 401, "Unauthorized");
      }

      try {
        const message = await arenaMessageService.postMessage(
          arenaId,
          userId,
          content,
          messageType,
        );

        res.status(201).json({
          id: message?.id,
          content: message?.content,
          messageType: message?.messageType,
          createdAt: message?.createdAt.toISOString(),
        });
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("Rate limit")) {
          return apiError(res, 429, err.message);
        }
        if (err.message.includes("exceeds maximum")) {
          return apiError(res, 400, err.message);
        }
        throw error;
      }
    }),
  );

  router.get(
    "/:arenaId/messages",
    asyncHandler(async (req, res) => {
      const { arenaId } = req.params;
      const { limit } = GetMessagesSchema.parse(req.query);

      const messages = await arenaMessageService.getArenaMessages(arenaId, limit);

      res.json({
        messages: messages.map((msg) => ({
          id: msg.id,
          userId: msg.userId,
          content: msg.content,
          messageType: msg.messageType,
          reportCount: msg.reportCount,
          createdAt: msg.createdAt.toISOString(),
        })),
      });
    }),
  );

  router.post(
    "/:arenaId/messages/:messageId/report",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { messageId } = req.params;
      const { reason } = ReportMessageSchema.parse(req.body);
      const userId = req.wallet;

      if (!userId) {
        return apiError(res, 401, "Unauthorized");
      }

      const report = await arenaMessageService.reportMessage(messageId, userId, reason);

      res.status(201).json({
        id: report.id,
        status: report.status,
        createdAt: report.createdAt.toISOString(),
      });
    }),
  );

  router.delete(
    "/:arenaId/messages/:messageId",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { messageId } = req.params;
      const userId = req.wallet;

      if (!userId) {
        return apiError(res, 401, "Unauthorized");
      }

      // Check if user is host or admin - for now just check if message is theirs
      const message = await (require("../db/prisma")).prisma.arenaMessage.findUnique({
        where: { id: messageId },
      });

      if (message?.userId !== userId) {
        return apiError(res, 403, "Forbidden");
      }

      const updated = await arenaMessageService.muteMessage(messageId);

      res.json({ success: true });
    }),
  );

  return router;
}
