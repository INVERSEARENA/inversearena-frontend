import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { apiError } from "../utils/apiError";
import { InvitationService } from "../services/invitationService";
import { randomUUID } from "crypto";

export function createInvitationsRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const invitationService = new InvitationService(prisma);

  /**
   * POST /api/arenas/:id/invitations
   * Create a new shareable invitation link for an arena.
   * Only the arena creator can create invitations.
   */
  router.post(
    "/:id/invitations",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const arenaId = req.params.id;
      const createdBy = req.user?.walletAddress;

      if (!createdBy) {
        throw apiError(401, "UNAUTHORIZED", "User wallet address required");
      }

      if (!arenaId) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena ID is required");
      }

      // Verify arena exists and user is the creator
      const arena = await prisma.arena.findUnique({
        where: { id: arenaId },
        select: { id: true, createdBy: true },
      });

      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena ${arenaId} not found`);
      }

      if (arena.createdBy !== createdBy) {
        throw apiError(403, "FORBIDDEN", "Only the arena creator can generate invitations");
      }

      const invitation = await invitationService.createInvitation(arenaId, createdBy);

      // Store the invitation in database
      await prisma.invitation.create({
        data: {
          code: invitation.code.toLowerCase(),
          arenaId: invitation.arenaId,
          createdBy: invitation.createdBy,
          expiresAt: invitation.expiresAt,
          maxUses: invitation.maxUses,
          usedCount: 0,
          isActive: true,
        },
      });

      res.status(201).json({
        invitation: {
          code: invitation.code,
          arenaId: invitation.arenaId,
          expiresAt: invitation.expiresAt.toISOString(),
          maxUses: invitation.maxUses,
          shareUrl: `/arenas/${arenaId}/join?invite=${invitation.code}`,
        },
        requestId: randomUUID(),
      });
    }),
  );

  /**
   * POST /api/arenas/:id/invitations/verify
   * Verify an invitation code before joining an arena.
   * This allows clients to validate invitations without performing a join.
   */
  router.post(
    "/:id/invitations/verify",
    asyncHandler(async (req, res) => {
      const { code } = z.object({ code: z.string() }).parse(req.body);
      const arenaId = req.params.id;

      if (!arenaId) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena ID is required");
      }

      const verification = await invitationService.verifyInvitation(code, arenaId);

      if (!verification.isValid) {
        res.status(403).json({
          isValid: false,
          error: verification.error,
          requestId: randomUUID(),
        });
        return;
      }

      res.json({
        isValid: true,
        invitation: {
          arenaId: verification.invitation!.arenaId,
          expiresAt: verification.invitation!.expiresAt.toISOString(),
          usedCount: verification.invitation!.usedCount,
          maxUses: verification.invitation!.maxUses,
          remainingUses: verification.invitation!.maxUses - verification.invitation!.usedCount,
        },
        requestId: randomUUID(),
      });
    }),
  );

  /**
   * GET /api/arenas/:id/invitations
   * List all active invitations for an arena.
   * Only the arena creator can view the list.
   */
  router.get(
    "/:id/invitations",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const arenaId = req.params.id;
      const userWallet = req.user?.walletAddress;

      if (!userWallet) {
        throw apiError(401, "UNAUTHORIZED", "User wallet address required");
      }

      if (!arenaId) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena ID is required");
      }

      // Verify arena exists and user is the creator
      const arena = await prisma.arena.findUnique({
        where: { id: arenaId },
        select: { id: true, createdBy: true },
      });

      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena ${arenaId} not found`);
      }

      if (arena.createdBy !== userWallet) {
        throw apiError(403, "FORBIDDEN", "Only the arena creator can view invitations");
      }

      const invitations = await invitationService.listInvitations(arenaId);

      res.json({
        invitations: invitations.map((inv) => ({
          code: inv.code,
          createdAt: inv.createdAt.toISOString(),
          expiresAt: inv.expiresAt.toISOString(),
          usedCount: inv.usedCount,
          maxUses: inv.maxUses,
          remainingUses: inv.maxUses - inv.usedCount,
          isActive: inv.isActive,
          shareUrl: `/arenas/${arenaId}/join?invite=${inv.code}`,
        })),
        requestId: randomUUID(),
      });
    }),
  );

  /**
   * POST /api/arenas/:id/invitations/:code/revoke
   * Revoke an invitation link.
   */
  router.post(
    "/:id/invitations/:code/revoke",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { id: arenaId, code } = req.params;
      const userWallet = req.user?.walletAddress;

      if (!userWallet) {
        throw apiError(401, "UNAUTHORIZED", "User wallet address required");
      }

      // Verify arena exists and user is the creator
      const arena = await prisma.arena.findUnique({
        where: { id: arenaId },
        select: { id: true, createdBy: true },
      });

      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena ${arenaId} not found`);
      }

      if (arena.createdBy !== userWallet) {
        throw apiError(403, "FORBIDDEN", "Only the arena creator can revoke invitations");
      }

      await invitationService.revokeInvitation(code, arenaId);

      res.json({
        success: true,
        message: "Invitation revoked",
        requestId: randomUUID(),
      });
    }),
  );

  return router;
}
