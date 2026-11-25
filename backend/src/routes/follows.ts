import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { followService } from "../services/followService";
import { apiError } from "../utils/apiError";
import type { Request } from "express";
import { cacheMiddleware } from "../middleware/cache";
import { publicCache } from "../middleware/cachePolicy";

const FollowSchema = z.object({
  followingId: z.string().uuid(),
});

const GetFollowersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

interface AuthRequest extends Request {
  wallet?: string;
}

export function createFollowsRouter(requireAuth: RequestHandler) {
  const router = Router();

  router.post(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { followingId } = FollowSchema.parse(req.body);
      const followerId = req.wallet;

      if (!followerId) {
        return apiError(res, 401, "Unauthorized");
      }

      try {
        const follow = await followService.follow(followerId, followingId);

        res.status(201).json({
          id: follow.id,
          followerId: follow.followerId,
          followingId: follow.followingId,
          createdAt: follow.createdAt.toISOString(),
        });
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("Cannot follow")) {
          return apiError(res, 400, err.message);
        }
        throw error;
      }
    }),
  );

  router.delete(
    "/:followingId",
    requireAuth,
    asyncHandler(async (req: AuthRequest, res) => {
      const { followingId } = req.params;
      const followerId = req.wallet;

      if (!followerId) {
        return apiError(res, 401, "Unauthorized");
      }

      await followService.unfollow(followerId, followingId);

      res.json({ success: true });
    }),
  );

  router.get(
    "/:userId/followers",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { limit } = GetFollowersSchema.parse(req.query);

      const followers = await followService.getFollowers(userId, limit);
      const count = await followService.getFollowerCount(userId);

      res.json({
        followers: followers.map((f) => ({
          id: f.id,
          followerId: f.followerId,
          createdAt: f.createdAt.toISOString(),
        })),
        total: count,
      });
    }),
  );

  router.get(
    "/:userId/following",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { limit } = GetFollowersSchema.parse(req.query);

      const following = await followService.getFollowing(userId, limit);
      const count = await followService.getFollowingCount(userId);

      res.json({
        following: following.map((f) => ({
          id: f.id,
          followingId: f.followingId,
          createdAt: f.createdAt.toISOString(),
        })),
        total: count,
      });
    }),
  );

  router.get(
    "/:userId/is-following/:targetId",
    asyncHandler(async (req, res) => {
      const { userId, targetId } = req.params;

      const isFollowing = await followService.isFollowing(userId, targetId);

      res.json({ isFollowing });
    }),
  );

  router.get(
    "/:userId/friends",
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { limit } = GetFollowersSchema.parse(req.query);

      const friends = await followService.getFriendsList(userId, limit);

      res.json({ friends });
    }),
  );

  return router;
}
