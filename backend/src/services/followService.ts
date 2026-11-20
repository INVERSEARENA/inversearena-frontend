import { prisma } from "../db/prisma";
import type { Follow } from "@prisma/client";

const MAX_FOLLOWERS = 10000;
const MAX_FOLLOWING = 1000;

export class FollowService {
  async follow(followerId: string, followingId: string): Promise<Follow> {
    if (followerId === followingId) {
      throw new Error("Cannot follow yourself");
    }

    // Check follow limits
    const followerCount = await prisma.follow.count({
      where: { followerId },
    });

    if (followerCount >= MAX_FOLLOWING) {
      throw new Error(`Cannot follow more than ${MAX_FOLLOWING} users`);
    }

    return prisma.follow.create({
      data: {
        followerId,
        followingId,
        isFollowable: true,
      },
    });
  }

  async unfollow(followerId: string, followingId: string): Promise<void> {
    await prisma.follow.deleteMany({
      where: {
        followerId,
        followingId,
      },
    });
  }

  async getFollowers(userId: string, limit: number = 100): Promise<Follow[]> {
    return prisma.follow.findMany({
      where: { followingId: userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getFollowing(userId: string, limit: number = 100): Promise<Follow[]> {
    return prisma.follow.findMany({
      where: { followerId: userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getFollowerCount(userId: string): Promise<number> {
    return prisma.follow.count({
      where: { followingId: userId },
    });
  }

  async getFollowingCount(userId: string): Promise<number> {
    return prisma.follow.count({
      where: { followerId: userId },
    });
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId,
        },
      },
    });
    return !!follow;
  }

  async getFriendsList(userId: string, limit: number = 100): Promise<string[]> {
    const follows = await this.getFollowing(userId, limit);
    return follows.map((f) => f.followingId);
  }

  async getFriendsPlayingNow(
    userId: string,
    limit: number = 20,
  ): Promise<Array<{ userId: string; arenaId: string }>> {
    // This would need to be joined with arena participation data
    // For now, returns a structure that frontend can consume
    const friends = await this.getFriendsList(userId);

    // TODO: Join with arena participation tracking
    // This requires arena participation data which should be tracked
    return [];
  }

  async setFollowability(userId: string, followable: boolean): Promise<void> {
    // This is a user preference that affects who can follow them
    // Would be stored in user preferences or a separate table
  }

  async checkFollowability(userId: string): Promise<boolean> {
    // Check if user allows being followed
    return true; // Default to followable
  }
}

export const followService = new FollowService();
