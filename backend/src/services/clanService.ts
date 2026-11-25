import { prisma } from "../db/prisma";
import type { Clan, ClanMember } from "@prisma/client";

const MAX_CLAN_SIZE = 100;
const MIN_TAG_LENGTH = 2;
const MAX_TAG_LENGTH = 5;

export class ClanService {
  validateTag(tag: string): boolean {
    return tag.length >= MIN_TAG_LENGTH && tag.length <= MAX_TAG_LENGTH && /^[A-Z0-9]+$/.test(tag);
  }

  async createClan(
    name: string,
    tag: string,
    ownerAddress: string,
    description?: string,
  ): Promise<Clan> {
    if (!this.validateTag(tag)) {
      throw new Error(
        `Invalid tag. Must be ${MIN_TAG_LENGTH}-${MAX_TAG_LENGTH} characters, uppercase letters and numbers only`,
      );
    }

    const clan = await prisma.clan.create({
      data: {
        name,
        tag: tag.toUpperCase(),
        ownerAddress,
        description,
        joinPolicy: "open",
        memberCount: 1,
      },
    });

    // Add owner as member
    await prisma.clanMember.create({
      data: {
        clanId: clan.id,
        userId: ownerAddress, // Using address as userId for now
        role: "owner",
      },
    });

    return clan;
  }

  async getClanById(clanId: string): Promise<Clan | null> {
    return prisma.clan.findUnique({
      where: { id: clanId },
      include: { members: true },
    });
  }

  async getClanByTag(tag: string): Promise<Clan | null> {
    return prisma.clan.findUnique({
      where: { tag: tag.toUpperCase() },
      include: { members: true },
    });
  }

  async joinClan(clanId: string, userId: string, role: string = "member"): Promise<ClanMember> {
    const clan = await this.getClanById(clanId);
    if (!clan) {
      throw new Error("Clan not found");
    }

    if (clan.memberCount >= MAX_CLAN_SIZE) {
      throw new Error(`Clan is full (max ${MAX_CLAN_SIZE} members)`);
    }

    // Check if user is already in a clan
    const existingMembership = await prisma.clanMember.findUnique({
      where: { userId },
    });

    if (existingMembership) {
      throw new Error("User is already in a clan");
    }

    // Add member
    const member = await prisma.clanMember.create({
      data: {
        clanId,
        userId,
        role,
      },
    });

    // Update clan member count
    await prisma.clan.update({
      where: { id: clanId },
      data: {
        memberCount: { increment: 1 },
      },
    });

    return member;
  }

  async leaveClan(clanId: string, userId: string): Promise<void> {
    const member = await prisma.clanMember.findUnique({
      where: { userId },
    });

    if (!member || member.clanId !== clanId) {
      throw new Error("User is not a member of this clan");
    }

    if (member.role === "owner") {
      throw new Error("Owner cannot leave clan. Transfer ownership first");
    }

    await prisma.clanMember.delete({
      where: { id: member.id },
    });

    // Update clan member count
    await prisma.clan.update({
      where: { id: clanId },
      data: {
        memberCount: { decrement: 1 },
      },
    });
  }

  async kickMember(clanId: string, userId: string, adminId: string): Promise<void> {
    const admin = await prisma.clanMember.findUnique({
      where: { userId: adminId },
    });

    if (!admin || admin.clanId !== clanId || !["owner", "officer"].includes(admin.role)) {
      throw new Error("Insufficient permissions");
    }

    const member = await prisma.clanMember.findUnique({
      where: { userId },
    });

    if (!member || member.clanId !== clanId) {
      throw new Error("User is not a member of this clan");
    }

    if (member.role === "owner") {
      throw new Error("Cannot kick clan owner");
    }

    await prisma.clanMember.delete({
      where: { id: member.id },
    });

    await prisma.clan.update({
      where: { id: clanId },
      data: {
        memberCount: { decrement: 1 },
      },
    });
  }

  async updateMemberRole(
    clanId: string,
    userId: string,
    newRole: "owner" | "officer" | "member",
    adminId: string,
  ): Promise<ClanMember> {
    const admin = await prisma.clanMember.findUnique({
      where: { userId: adminId },
    });

    if (!admin || admin.clanId !== clanId || admin.role !== "owner") {
      throw new Error("Only owner can change roles");
    }

    return prisma.clanMember.update({
      where: { userId },
      data: { role: newRole },
    });
  }

  async getClanLeaderboard(limit: number = 100): Promise<Clan[]> {
    return prisma.clan.findMany({
      orderBy: [{ totalWins: "desc" }, { createdAt: "desc" }],
      take: limit,
    });
  }

  async getClanMembers(clanId: string): Promise<ClanMember[]> {
    return prisma.clanMember.findMany({
      where: { clanId },
      orderBy: { role: "asc" },
    });
  }

  async updateClanStats(
    clanId: string,
    wins?: number,
    staked?: number,
  ): Promise<Clan> {
    const data: Record<string, any> = {};
    if (wins !== undefined) data.totalWins = { increment: wins };
    if (staked !== undefined) data.totalStaked = { increment: staked };

    return prisma.clan.update({
      where: { id: clanId },
      data,
    });
  }
}

export const clanService = new ClanService();
