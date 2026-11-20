import { describe, it, expect, beforeEach, vi } from "vitest";
import { clanService } from "../clanService";
import { prisma } from "../../db/prisma";

vi.mock("../../db/prisma");

describe("ClanService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should validate tag correctly", () => {
    expect(clanService.validateTag("CLAN")).toBe(true);
    expect(clanService.validateTag("AB123")).toBe(true);
    expect(clanService.validateTag("a")).toBe(false); // too short and lowercase
    expect(clanService.validateTag("TOOLONG123")).toBe(false); // too long
    expect(clanService.validateTag("cl@n")).toBe(false); // invalid character
  });

  it("should create clan", async () => {
    const mockClan = {
      id: "clan1",
      name: "Alpha Squad",
      tag: "ALPH",
      ownerAddress: "0x123",
      memberCount: 1,
      totalWins: 0,
      totalStaked: 0,
      avgWinRate: 0,
      joinPolicy: "open",
      description: "Top clan",
      imageUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.clan.create as any).mockResolvedValue(mockClan);
    (prisma.clanMember.create as any).mockResolvedValue({});

    const result = await clanService.createClan("Alpha Squad", "ALPH", "0x123", "Top clan");
    expect(result.name).toBe("Alpha Squad");
    expect(result.tag).toBe("ALPH");
  });

  it("should reject invalid tag on creation", async () => {
    await expect(clanService.createClan("Test", "invalid", "0x123")).rejects.toThrow(
      "Invalid tag",
    );
  });

  it("should join clan", async () => {
    const mockClan = {
      id: "clan1",
      memberCount: 5,
    };

    (prisma.clan.findUnique as any).mockResolvedValue(mockClan);
    (prisma.clanMember.findUnique as any).mockResolvedValue(null);
    (prisma.clanMember.create as any).mockResolvedValue({
      id: "member1",
      clanId: "clan1",
      userId: "user1",
      role: "member",
      joinedAt: new Date(),
      createdAt: new Date(),
    });
    (prisma.clan.update as any).mockResolvedValue({});

    const result = await clanService.joinClan("clan1", "user1");
    expect(result.role).toBe("member");
  });

  it("should prevent user from joining when already in clan", async () => {
    const mockClan = { id: "clan1", memberCount: 5 };
    const existingMember = { userId: "user1", clanId: "clan1" };

    (prisma.clan.findUnique as any).mockResolvedValue(mockClan);
    (prisma.clanMember.findUnique as any).mockResolvedValue(existingMember);

    await expect(clanService.joinClan("clan1", "user1")).rejects.toThrow(
      "User is already in a clan",
    );
  });

  it("should get clan leaderboard", async () => {
    const mockClans = [
      {
        id: "clan1",
        name: "Elite",
        tag: "ELIT",
        totalWins: 100,
        createdAt: new Date(),
      },
      {
        id: "clan2",
        name: "Rising",
        tag: "RISE",
        totalWins: 50,
        createdAt: new Date(),
      },
    ];

    (prisma.clan.findMany as any).mockResolvedValue(mockClans);

    const result = await clanService.getClanLeaderboard();
    expect(result).toHaveLength(2);
    expect(result[0].totalWins).toBeGreaterThan(result[1].totalWins);
  });
});
