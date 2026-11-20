import { describe, it, expect, beforeEach, vi } from "vitest";
import { followService } from "../followService";
import { prisma } from "../../db/prisma";

vi.mock("../../db/prisma");

describe("FollowService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should follow another user", async () => {
    const mockFollow = {
      id: "follow1",
      followerId: "user1",
      followingId: "user2",
      isFollowable: true,
      createdAt: new Date(),
    };

    (prisma.follow.create as any).mockResolvedValue(mockFollow);

    const result = await followService.follow("user1", "user2");
    expect(result.followerId).toBe("user1");
    expect(result.followingId).toBe("user2");
  });

  it("should prevent self-follow", async () => {
    await expect(followService.follow("user1", "user1")).rejects.toThrow(
      "Cannot follow yourself",
    );
  });

  it("should unfollow user", async () => {
    (prisma.follow.deleteMany as any).mockResolvedValue({ count: 1 });

    await followService.unfollow("user1", "user2");
    expect(prisma.follow.deleteMany).toHaveBeenCalled();
  });

  it("should get followers", async () => {
    const mockFollowers = [
      {
        id: "follow1",
        followerId: "user1",
        followingId: "user2",
        isFollowable: true,
        createdAt: new Date(),
      },
    ];

    (prisma.follow.findMany as any).mockResolvedValue(mockFollowers);

    const result = await followService.getFollowers("user2");
    expect(result).toHaveLength(1);
    expect(result[0].followerId).toBe("user1");
  });

  it("should check if following", async () => {
    (prisma.follow.findUnique as any).mockResolvedValue({
      id: "follow1",
      followerId: "user1",
      followingId: "user2",
    });

    const result = await followService.isFollowing("user1", "user2");
    expect(result).toBe(true);
  });

  it("should get following count", async () => {
    (prisma.follow.count as any).mockResolvedValue(5);

    const result = await followService.getFollowingCount("user1");
    expect(result).toBe(5);
  });
});
