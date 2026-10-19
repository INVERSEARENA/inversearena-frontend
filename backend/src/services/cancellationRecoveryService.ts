/**
 * Cancellation Recovery Service (#1398)
 *
 * Implements cancellation recovery status for every participant.
 * Each participant can see refundable, submitted, confirmed, or failed recovery state.
 */

import { PrismaClient, type Arena, type Round } from "@prisma/client";

export type RecoveryStatus = "refundable" | "submitted" | "confirmed" | "failed";

export interface ParticipantRecovery {
  userId: string;
  walletAddress: string;
  arenaId: string;
  arenaName: string;
  totalStaked: number;
  recoveryStatus: RecoveryStatus;
  refundAmount: number;
  submittedAt?: string;
  confirmedAt?: string;
  failureReason?: string;
  txHash?: string;
}

export interface ArenaCancellationRecovery {
  arenaId: string;
  arenaName: string;
  cancelledAt: string;
  participants: ParticipantRecovery[];
  totalRefundable: number;
  totalRefunded: number;
}

export class CancellationRecoveryService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get cancellation recovery status for an arena.
   */
  async getArenaRecovery(arenaId: string): Promise<ArenaCancellationRecovery | null> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      include: {
        rounds: {
          include: {
            eliminationLogs: true,
          },
        },
      },
    });

    if (!arena) {
      return null;
    }

    const metadata = (arena.metadata as Record<string, unknown>) ?? {};
    const arenaName = (metadata.name as string) ?? `Arena ${arena.id.slice(0, 8)}`;

    // Check if arena was cancelled
    const isCancelled = arena.rounds.some((r) => {
      const roundMetadata = (r.metadata as Record<string, unknown>) ?? {};
      return roundMetadata.cancelled === true;
    });

    if (!isCancelled) {
      return null;
    }

    // Find the cancellation timestamp
    const cancelledRound = arena.rounds.find((r) => {
      const roundMetadata = (r.metadata as Record<string, unknown>) ?? {};
      return roundMetadata.cancelled === true;
    });

    const cancelledAt = cancelledRound?.createdAt.toISOString() ?? arena.updatedAt.toISOString();

    // Get all participants across all rounds
    const allParticipants = new Map<string, { userId: string; totalStaked: number }>();

    for (const round of arena.rounds) {
      const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
      const playerChoices = (roundMetadata.playerChoices as Array<{ userId: string; stake: number }>) ?? [];

      for (const choice of playerChoices) {
        const existing = allParticipants.get(choice.userId);
        if (existing) {
          existing.totalStaked += choice.stake;
        } else {
          allParticipants.set(choice.userId, {
            userId: choice.userId,
            totalStaked: choice.stake,
          });
        }
      }
    }

    // Get user wallet addresses
    const userIds = Array.from(allParticipants.keys());
    const users = userIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
        })
      : [];

    const userById = new Map(users.map((u) => [u.id, u.walletAddress]));

    // Build participant recovery records
    const participants: ParticipantRecovery[] = [];
    let totalRefundable = 0;
    let totalRefunded = 0;

    for (const [userId, data] of allParticipants) {
      const walletAddress = userById.get(userId) ?? userId;

      // Check recovery status from metadata
      const recoveryMetadata = (metadata.recoveryStatus as Record<string, Record<string, unknown>>)?.[userId];
      const recoveryStatus = (recoveryMetadata?.status as RecoveryStatus) ?? "refundable";
      const refundAmount = (recoveryMetadata?.refundAmount as number) ?? data.totalStaked;
      const submittedAt = recoveryMetadata?.submittedAt as string | undefined;
      const confirmedAt = recoveryMetadata?.confirmedAt as string | undefined;
      const failureReason = recoveryMetadata?.failureReason as string | undefined;
      const txHash = recoveryMetadata?.txHash as string | undefined;

      participants.push({
        userId,
        walletAddress,
        arenaId: arena.id,
        arenaName,
        totalStaked: data.totalStaked,
        recoveryStatus,
        refundAmount,
        submittedAt,
        confirmedAt,
        failureReason,
        txHash,
      });

      if (recoveryStatus === "refundable") {
        totalRefundable += refundAmount;
      } else if (recoveryStatus === "confirmed") {
        totalRefunded += refundAmount;
      }
    }

    return {
      arenaId: arena.id,
      arenaName,
      cancelledAt,
      participants,
      totalRefundable,
      totalRefunded,
    };
  }

  /**
   * Get recovery status for a specific user across all cancelled arenas.
   */
  async getUserRecoveryStatus(userId: string): Promise<ParticipantRecovery[]> {
    // Find all cancelled arenas where the user participated
    const arenas = await this.prisma.arena.findMany({
      include: {
        rounds: true,
      },
    });

    const results: ParticipantRecovery[] = [];

    for (const arena of arenas) {
      const metadata = (arena.metadata as Record<string, unknown>) ?? {};

      // Check if arena was cancelled
      const isCancelled = arena.rounds.some((r) => {
        const roundMetadata = (r.metadata as Record<string, unknown>) ?? {};
        return roundMetadata.cancelled === true;
      });

      if (!isCancelled) continue;

      // Check if user participated
      let userStaked = 0;
      for (const round of arena.rounds) {
        const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
        const playerChoices = (roundMetadata.playerChoices as Array<{ userId: string; stake: number }>) ?? [];
        const userChoice = playerChoices.find((c) => c.userId === userId);
        if (userChoice) {
          userStaked += userChoice.stake;
        }
      }

      if (userStaked === 0) continue;

      // Get recovery status
      const recoveryMetadata = (metadata.recoveryStatus as Record<string, Record<string, unknown>>)?.[userId];
      const recoveryStatus = (recoveryMetadata?.status as RecoveryStatus) ?? "refundable";
      const refundAmount = (recoveryMetadata?.refundAmount as number) ?? userStaked;

      const arenaName = (metadata.name as string) ?? `Arena ${arena.id.slice(0, 8)}`;

      results.push({
        userId,
        walletAddress: "", // Will be filled by caller if needed
        arenaId: arena.id,
        arenaName,
        totalStaked: userStaked,
        recoveryStatus,
        refundAmount,
        submittedAt: recoveryMetadata?.submittedAt as string | undefined,
        confirmedAt: recoveryMetadata?.confirmedAt as string | undefined,
        failureReason: recoveryMetadata?.failureReason as string | undefined,
        txHash: recoveryMetadata?.txHash as string | undefined,
      });
    }

    return results;
  }

  /**
   * Update recovery status for a participant.
   */
  async updateRecoveryStatus(
    arenaId: string,
    userId: string,
    status: RecoveryStatus,
    details: {
      refundAmount?: number;
      txHash?: string;
      failureReason?: string;
    } = {},
  ): Promise<void> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
    });

    if (!arena) {
      throw new Error(`Arena ${arenaId} not found`);
    }

    const metadata = (arena.metadata as Record<string, unknown>) ?? {};
    const recoveryStatus = (metadata.recoveryStatus as Record<string, Record<string, unknown>>) ?? {};

    recoveryStatus[userId] = {
      status,
      ...details,
      updatedAt: new Date().toISOString(),
      ...(status === "submitted" && { submittedAt: new Date().toISOString() }),
      ...(status === "confirmed" && { confirmedAt: new Date().toISOString() }),
    };

    await this.prisma.arena.update({
      where: { id: arenaId },
      data: {
        metadata: {
          ...metadata,
          recoveryStatus,
        },
      },
    });
  }
}
