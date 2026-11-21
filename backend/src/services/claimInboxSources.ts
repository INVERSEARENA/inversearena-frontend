import type { PrismaClient } from "@prisma/client";
import type { TransactionRepository } from "../repositories/transactionRepository";
import type { ClaimInboxRefundCandidate } from "./claimInboxService";
import type { CancellationRecoveryService } from "./cancellationRecoveryService";

export interface PayoutClaimSource {
  list(walletAddress: string, limit: number, cursor: { updatedAt: Date; id: string } | null): ReturnType<TransactionRepository["listByDestination"]>;
}

/** Adapter over Mongo payout records, scoped to the requesting wallet. */
export class TransactionPayoutClaimSource implements PayoutClaimSource {
  constructor(private readonly transactions: TransactionRepository) {}

  list(walletAddress: string, limit: number, cursor: { updatedAt: Date; id: string } | null) {
    return this.transactions.listByDestination(walletAddress, limit, cursor);
  }
}

function refundAmountToStroops(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  return Math.floor(amount * 10_000_000).toString();
}

/** Adapter over PostgreSQL cancellation recovery for one wallet. */
export function createCancellationRefundClaimSource(
  prisma: PrismaClient,
  cancellation: CancellationRecoveryService,
): (walletAddress: string) => Promise<ClaimInboxRefundCandidate[]> {
  return async (walletAddress) => {
    const rows = await prisma.round.findMany({
      where: {
        OR: [
          { eliminationLogs: { some: { userId: walletAddress } } },
          { allActivePlayerIds: { has: walletAddress } },
        ],
      },
      select: { arenaId: true },
      distinct: ["arenaId"],
      take: 50,
    });

    const candidates: ClaimInboxRefundCandidate[] = [];
    for (const row of rows) {
      const recovery = await cancellation.getArenaRecovery(row.arenaId);
      if (!recovery) continue;
      for (const participant of recovery.participants) {
        if (participant.walletAddress !== walletAddress) continue;
        candidates.push({
          arenaId: participant.arenaId,
          arenaName: participant.arenaName,
          walletAddress: participant.walletAddress,
          assetCode: "XLM",
          refundAmountStroops: refundAmountToStroops(participant.refundAmount),
          recoveryStatus: participant.recoveryStatus,
          txHash: participant.txHash ?? null,
          confirmedAt: participant.confirmedAt ?? null,
          updatedAt: participant.submittedAt ? new Date(participant.submittedAt) : null,
        });
      }
    }
    return candidates;
  };
}
