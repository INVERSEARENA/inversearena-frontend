import { prisma } from "../db/prisma";
import type { Jackpot, JackpotAward } from "@prisma/client";

export class JackpotService {
  async getJackpotByToken(stakeToken: string): Promise<Jackpot | null> {
    return prisma.jackpot.findUnique({
      where: { stakeToken },
    });
  }

  async createOrGetJackpot(
    stakeToken: string,
    shareBps: number = 500,
  ): Promise<Jackpot> {
    return prisma.jackpot.upsert({
      where: { stakeToken },
      update: {},
      create: {
        stakeToken,
        shareBps,
        awardRule: "PERFECT_STREAK",
        balanceAtomic: 0n,
      },
    });
  }

  async updateJackpotBalance(
    jackpotId: string,
    amountAtomic: bigint,
    increment: boolean = true,
  ): Promise<Jackpot> {
    const operation = increment ? { increment: amountAtomic } : { decrement: Math.abs(Number(amountAtomic)) };
    return prisma.jackpot.update({
      where: { id: jackpotId },
      data: {
        balanceAtomic: operation,
      },
    });
  }

  async recordAward(
    jackpotId: string,
    arenaId: string,
    winnerId: string,
    amountAtomic: bigint,
    awardReason: string,
  ): Promise<JackpotAward> {
    // Deduct from jackpot balance
    await this.updateJackpotBalance(jackpotId, amountAtomic, false);

    return prisma.jackpotAward.create({
      data: {
        jackpotId,
        arenaId,
        winnerId,
        amountAtomic,
        awardReason,
        status: "pending",
      },
    });
  }

  async getJackpotHistory(
    stakeToken: string,
    limit: number = 50,
  ): Promise<JackpotAward[]> {
    const jackpot = await this.getJackpotByToken(stakeToken);
    if (!jackpot) return [];

    return prisma.jackpotAward.findMany({
      where: { jackpotId: jackpot.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async updateAwardStatus(
    awardId: string,
    status: "pending" | "paid" | "failed",
    txHash?: string,
  ): Promise<JackpotAward> {
    return prisma.jackpotAward.update({
      where: { id: awardId },
      data: {
        status,
        txHash: txHash || undefined,
      },
    });
  }

  async evaluateAwardRule(
    arenaId: string,
    winnerId: string,
    roundsSurvived: number,
  ): Promise<boolean> {
    const jackpot = await prisma.jackpot.findFirst({
      where: { awardRule: "PERFECT_STREAK" },
    });

    if (!jackpot || !jackpot.awardThreshold) return false;
    return roundsSurvived >= jackpot.awardThreshold;
  }
}

export const jackpotService = new JackpotService();
