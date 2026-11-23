import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const QUALIFICATION_THRESHOLD = {
  minArenaCount: 3,
  minStakeUsd: 5,
};

const ATTRIBUTION_WINDOW_HOURS = 30 * 24; // 30 days

export class ReferralService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Generate a new referral code for a player
   */
  async generateReferralCode(referrerId: string): Promise<string> {
    const code = randomBytes(8).toString("hex").toUpperCase();
    const attributionWindowExpiresAt = new Date(
      Date.now() + ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000,
    );

    await this.prisma.referralCode.create({
      data: {
        referrerId,
        code,
        attributionWindowExpiresAt,
      },
    });

    return code;
  }

  /**
   * Get or create referral code for a player
   */
  async getOrCreateReferralCode(referrerId: string): Promise<string> {
    const existing = await this.prisma.referralCode.findFirst({
      where: { referrerId },
      select: { code: true },
    });

    if (existing) {
      return existing.code;
    }

    return this.generateReferralCode(referrerId);
  }

  /**
   * Attribute a signup to a referral code (called on first login)
   * Returns the referrer ID if attribution was successful, null if invalid/expired
   */
  async attributeSignup(
    referralCode: string,
    refereeId: string,
  ): Promise<string | null> {
    const now = new Date();

    const codeRecord = await this.prisma.referralCode.findUnique({
      where: { code: referralCode },
      include: { referrer: true },
    });

    if (
      !codeRecord ||
      codeRecord.attributionWindowExpiresAt < now ||
      codeRecord.referrerId === refereeId
    ) {
      // Invalid code, expired, or self-referral
      return null;
    }

    // Check if referee already has a referral reward for this code
    const existing = await this.prisma.referralReward.findUnique({
      where: {
        referralCodeId_refereeId: {
          referralCodeId: codeRecord.id,
          refereeId,
        },
      },
    });

    if (existing) {
      return null; // Already attributed
    }

    // Create pending reward entry
    await this.prisma.referralReward.create({
      data: {
        referralCodeId: codeRecord.id,
        refereeId,
        state: "pending",
      },
    });

    return codeRecord.referrerId;
  }

  /**
   * Check and update qualification status for a referee
   * Called after each arena completion
   */
  async updateQualificationStatus(refereeId: string): Promise<void> {
    const rewards = await this.prisma.referralReward.findMany({
      where: {
        refereeId,
        state: "pending",
      },
    });

    if (rewards.length === 0) {
      return;
    }

    // Count unique arenas where referee participated (has elimination log)
    const arenaIds = await this.prisma.eliminationLog.findMany({
      where: { userId: refereeId },
      select: { roundId: true },
      distinct: ["roundId"],
    });

    // Get round arena mapping
    const rounds = await this.prisma.round.findMany({
      where: { id: { in: arenaIds.map((a) => a.roundId) } },
      select: { arenaId: true },
      distinct: ["arenaId"],
    });

    // Get total stake from pools for those arenas
    const stakeData = await this.prisma.pool.aggregate({
      _sum: { stakeAmount: true },
      where: { arenaId: { in: rounds.map((r) => r.arenaId) } },
    });

    const arenaCount = rounds.length;
    const totalStake = stakeData._sum.stakeAmount || 0;

    if (
      arenaCount >= QUALIFICATION_THRESHOLD.minArenaCount &&
      totalStake >= QUALIFICATION_THRESHOLD.minStakeUsd
    ) {
      // Update all pending rewards to qualified
      await this.prisma.referralReward.updateMany({
        where: {
          refereeId,
          state: "pending",
        },
        data: {
          state: "qualified",
          arenaCount,
          totalStake,
          qualifiedAt: new Date(),
          rewardAmount: totalStake * 0.05, // 5% of stake as reward (configurable)
        },
      });
    }
  }

  /**
   * Get referral dashboard data for a player
   */
  async getReferralDashboard(referrerId: string) {
    const referralCode = await this.prisma.referralCode.findFirst({
      where: { referrerId },
      select: { code: true },
    });

    const rewards = await this.prisma.referralReward.findMany({
      where: {
        referralCode: {
          referrerId,
        },
      },
      include: {
        referee: {
          select: { walletAddress: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const stats = {
      totalReferrals: rewards.length,
      activeReferrals: rewards.filter((r) => r.state === "pending").length,
      qualifiedReferrals: rewards.filter((r) => r.state === "qualified").length,
      paidReferrals: rewards.filter((r) => r.state === "paid").length,
      totalEarnings: rewards
        .filter((r) => r.state === "paid")
        .reduce((sum, r) => sum + (r.rewardAmount || 0), 0),
      pendingRewards: rewards
        .filter((r) => r.state === "qualified")
        .reduce((sum, r) => sum + (r.rewardAmount || 0), 0),
    };

    return {
      code: referralCode?.code || null,
      referrals: rewards.map((r) => ({
        id: r.id,
        referee: r.referee.walletAddress,
        state: r.state,
        arenaCount: r.arenaCount,
        totalStake: r.totalStake,
        rewardAmount: r.rewardAmount,
        qualifiedAt: r.qualifiedAt,
        paidAt: r.paidAt,
      })),
      stats,
    };
  }

  /**
   * Mark rewards as paid (called by payout system)
   */
  async markAsPaid(rewardIds: string[]): Promise<void> {
    await this.prisma.referralReward.updateMany({
      where: { id: { in: rewardIds }, state: "qualified" },
      data: { state: "paid", paidAt: new Date() },
    });
  }

  /**
   * Revoke a reward (e.g., self-referral detected, budget exhausted)
   */
  async revokeReward(rewardId: string, reason: string): Promise<void> {
    await this.prisma.referralReward.update({
      where: { id: rewardId },
      data: { state: "revoked", revokeReason: reason },
    });
  }
}

export const referralService = (prisma: PrismaClient) =>
  new ReferralService(prisma);
