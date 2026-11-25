import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { clanService } from "../services/clanService";
import { apiError } from "../utils/apiError";
import type { Request } from "express";
import { cacheMiddleware } from "../middleware/cache";
import { publicCache } from "../middleware/cachePolicy";

const CreateClanSchema = z.object({
  name: z.string().trim().min(1).max(50),
  tag: z.string().trim().min(2).max(5),
  description: z.string().trim().max(500).optional(),
});

const JoinClanSchema = z.object({
  clanId: z.string().uuid(),
});

const UpdateRoleSchema = z.object({
  userId: z.string().uuid(),
  newRole: z.enum(["owner", "officer", "member"]),
});

const LeaderboardSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface AuthRequest extends Request {
  wallet?: string;
}

export function createClansRouter(requireAuth: RequestHandler) {
  const router = Router();

  router.post(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { name, tag, description } = CreateClanSchema.parse(req.body);
      const ownerAddress = req.wallet;

      if (!ownerAddress) {
        return apiError(res, 401, "Unauthorized");
      }

      try {
        const clan = await clanService.createClan(name, tag, ownerAddress, description);

        res.status(201).json({
          id: clan.id,
          name: clan.name,
          tag: clan.tag,
          ownerAddress: clan.ownerAddress,
          memberCount: clan.memberCount,
          description: clan.description,
          createdAt: clan.createdAt.toISOString(),
        });
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("Invalid tag")) {
          return apiError(res, 400, err.message);
        }
        throw error;
      }
    }),
  );

  router.get(
    "/:clanId",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { clanId } = req.params;

      const clan = await clanService.getClanById(clanId);

      if (!clan) {
        return apiError(res, 404, "Clan not found");
      }

      res.json({
        id: clan.id,
        name: clan.name,
        tag: clan.tag,
        ownerAddress: clan.ownerAddress,
        memberCount: clan.memberCount,
        totalWins: clan.totalWins,
        totalStaked: clan.totalStaked,
        avgWinRate: clan.avgWinRate,
        joinPolicy: clan.joinPolicy,
        description: clan.description,
        imageUrl: clan.imageUrl,
        createdAt: clan.createdAt.toISOString(),
      });
    }),
  );

  router.get(
    "/tag/:tag",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { tag } = req.params;

      const clan = await clanService.getClanByTag(tag);

      if (!clan) {
        return apiError(res, 404, "Clan not found");
      }

      res.json({
        id: clan.id,
        name: clan.name,
        tag: clan.tag,
        ownerAddress: clan.ownerAddress,
        memberCount: clan.memberCount,
        totalWins: clan.totalWins,
        totalStaked: clan.totalStaked,
        avgWinRate: clan.avgWinRate,
        joinPolicy: clan.joinPolicy,
        createdAt: clan.createdAt.toISOString(),
      });
    }),
  );

  router.post(
    "/:clanId/join",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { clanId } = req.params;
      const userId = req.wallet;

      if (!userId) {
        return apiError(res, 401, "Unauthorized");
      }

      try {
        const member = await clanService.joinClan(clanId, userId);

        res.status(201).json({
          id: member.id,
          clanId: member.clanId,
          userId: member.userId,
          role: member.role,
          joinedAt: member.joinedAt.toISOString(),
        });
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("not found") || err.message.includes("full") || err.message.includes("already")) {
          return apiError(res, 400, err.message);
        }
        throw error;
      }
    }),
  );

  router.post(
    "/:clanId/leave",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { clanId } = req.params;
      const userId = req.wallet;

      if (!userId) {
        return apiError(res, 401, "Unauthorized");
      }

      try {
        await clanService.leaveClan(clanId, userId);
        res.json({ success: true });
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("not a member") || err.message.includes("Cannot leave")) {
          return apiError(res, 400, err.message);
        }
        throw error;
      }
    }),
  );

  router.post(
    "/:clanId/kick/:userId",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { clanId, userId } = req.params;
      const adminId = req.wallet;

      if (!adminId) {
        return apiError(res, 401, "Unauthorized");
      }

      try {
        await clanService.kickMember(clanId, userId, adminId);
        res.json({ success: true });
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("permissions") || err.message.includes("not a member") || err.message.includes("Cannot kick")) {
          return apiError(res, 403, err.message);
        }
        throw error;
      }
    }),
  );

  router.post(
    "/:clanId/members/:userId/role",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { clanId, userId } = req.params;
      const { newRole } = UpdateRoleSchema.parse(req.body);
      const adminId = req.wallet;

      if (!adminId) {
        return apiError(res, 401, "Unauthorized");
      }

      try {
        const updated = await clanService.updateMemberRole(clanId, userId, newRole, adminId);

        res.json({
          id: updated.id,
          role: updated.role,
        });
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("only owner")) {
          return apiError(res, 403, err.message);
        }
        throw error;
      }
    }),
  );

  router.get(
    "/:clanId/members",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { clanId } = req.params;

      const members = await clanService.getClanMembers(clanId);

      res.json({
        members: members.map((m) => ({
          id: m.id,
          userId: m.userId,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        })),
      });
    }),
  );

  router.get(
    "/leaderboard",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { limit } = LeaderboardSchema.parse(req.query);

      const clans = await clanService.getClanLeaderboard(limit);

      res.json({
        clans: clans.map((clan) => ({
          id: clan.id,
          name: clan.name,
          tag: clan.tag,
          memberCount: clan.memberCount,
          totalWins: clan.totalWins,
          totalStaked: clan.totalStaked,
          avgWinRate: clan.avgWinRate,
          rank: 0, // Will be populated by frontend based on order
        })),
      });
    }),
  );

  return router;
}
