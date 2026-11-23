/** Cancellation recovery is derived from typed round data and live contract state. */
import { PrismaClient, type Arena, type Round } from "@prisma/client";
import { readOnChainGameState, readOnChainPlayerStatus } from "./onChainReader";
import { isVerifiedRead } from "../types/onChainRead";
import type { PlayerChoice } from "../types/round";

export type RecoveryStatus = "refundable" | "submitted" | "confirmed" | "failed";

export interface ParticipantRecovery {
  userId: string;
  walletAddress: string;
  arenaId: string;
  arenaName: string;
  totalStaked: number;
  recoveryStatus: RecoveryStatus;
  refundAmount: number;
  failureReason?: string;
}

export interface ArenaCancellationRecovery {
  arenaId: string;
  arenaName: string;
  cancelledAt: string;
  participants: ParticipantRecovery[];
  totalRefundable: number;
  totalRefunded: number;
}

type ParticipantStake = { userId: string; totalStaked: number };

/** Typed Round.playerChoices is the persisted participant/stake source. */
function collectParticipants(rounds: Round[]): Map<string, ParticipantStake> {
  const participants = new Map<string, ParticipantStake>();
  for (const round of rounds) {
    const choices = Array.isArray(round.playerChoices)
      ? (round.playerChoices as unknown as PlayerChoice[])
      : [];
    for (const choice of choices) {
      if (!choice || typeof choice.userId !== "string" || typeof choice.stake !== "number") continue;
      const current = participants.get(choice.userId);
      if (current) current.totalStaked += choice.stake;
      else participants.set(choice.userId, { userId: choice.userId, totalStaked: choice.stake });
    }
  }
  return participants;
}

export class CancellationRecoveryService {
  constructor(private prisma: PrismaClient) {}

  async getArenaRecovery(arenaId: string): Promise<ArenaCancellationRecovery | null> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      include: { rounds: { orderBy: { roundNumber: "asc" } } },
    });
    if (!arena) return null;

    const chainState = await readOnChainGameState(arena.id);
    if (!isVerifiedRead(chainState) || chainState.value !== "Cancelled") return null;

    const participants = collectParticipants(arena.rounds);
    const users = participants.size
      ? await this.prisma.user.findMany({ where: { id: { in: [...participants.keys()] } } })
      : [];
    const walletById = new Map(users.map((user) => [user.id, user.walletAddress]));
    const records = await Promise.all([...participants.values()].map((participant) =>
      this.toRecovery(arena, participant, walletById.get(participant.userId) ?? ""),
    ));
    return this.buildArenaRecovery(arena, records);
  }

  async getUserRecoveryStatus(userId: string): Promise<ParticipantRecovery[]> {
    const [arenas, user] = await Promise.all([
      this.prisma.arena.findMany({ include: { rounds: { orderBy: { roundNumber: "asc" } } } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { walletAddress: true } }),
    ]);
    if (!user?.walletAddress) return [];

    const results: ParticipantRecovery[] = [];
    for (const arena of arenas) {
      const participant = collectParticipants(arena.rounds).get(userId);
      if (!participant) continue;
      const state = await readOnChainGameState(arena.id);
      if (!isVerifiedRead(state) || state.value !== "Cancelled") continue;
      results.push(await this.toRecovery(arena, participant, user.walletAddress));
    }
    return results;
  }

  private async toRecovery(
    arena: Arena,
    participant: ParticipantStake,
    walletAddress: string,
  ): Promise<ParticipantRecovery> {
    const status = walletAddress
      ? await readOnChainPlayerStatus(arena.id, walletAddress)
      : null;
    const recoveryStatus: RecoveryStatus = status && isVerifiedRead(status) && status.value.joined
      ? status.value.refundClaimed ? "confirmed" : "refundable"
      : "failed";
    return {
      userId: participant.userId,
      walletAddress,
      arenaId: arena.id,
      arenaName: `Arena ${arena.id.slice(0, 8)}`,
      totalStaked: participant.totalStaked,
      recoveryStatus,
      refundAmount: participant.totalStaked,
      ...(status && isVerifiedRead(status)
        ? status.value.joined ? {} : { failureReason: "Wallet is not recorded as a participant on-chain." }
        : { failureReason: "Could not verify refund status on-chain; retry later." }),
    };
  }

  private buildArenaRecovery(arena: Arena, participants: ParticipantRecovery[]): ArenaCancellationRecovery {
    const cancelledRound = (arena as Arena & { rounds?: Round[] }).rounds?.find((round) => round.state === "CANCELLED");
    return {
      arenaId: arena.id,
      arenaName: `Arena ${arena.id.slice(0, 8)}`,
      cancelledAt: (cancelledRound?.updatedAt ?? arena.updatedAt).toISOString(),
      participants,
      totalRefundable: participants.filter((p) => p.recoveryStatus === "refundable").reduce((sum, p) => sum + p.refundAmount, 0),
      totalRefunded: participants.filter((p) => p.recoveryStatus === "confirmed").reduce((sum, p) => sum + p.refundAmount, 0),
    };
  }
}
