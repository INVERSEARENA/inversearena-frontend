import { PrismaClient } from "@prisma/client";
import { ArenaStats } from "../types/arena";

export class ArenaStatsService {
  constructor(private prisma: PrismaClient) {}

  async getArenaStats(arenaId: string): Promise<ArenaStats> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      include: {
        rounds: {
          orderBy: { roundNumber: "asc" },
          include: {
            eliminationLogs: true,
          },
        },
      },
    });

    if (!arena) {
      throw new Error(`Arena with ID ${arenaId} not found`);
    }

    const metadata = (arena.metadata as Record<string, unknown>) ?? {};
    const entryFee =
      (metadata.entryFee as number | undefined) ??
      (metadata.minStake as number | undefined) ??
      0;
    const maxPlayers = (metadata.maxPlayers as number | undefined) ?? 0;
    const joinDeadline =
      typeof metadata.joinDeadline === "string" ? metadata.joinDeadline : null;
    const arenaName =
      (metadata.name as string | undefined) ?? `Arena ${arenaId.slice(0, 8)}`;
    const stakeToken =
      (metadata.stakeToken as string | undefined) ?? "XLM";

    const rounds = arena.rounds;
    const lastRound = rounds[rounds.length - 1];
    const currentRound = lastRound !== undefined ? lastRound.roundNumber : 0;

    const playerCount = await this.prisma.pool.count({ where: { arenaId } });

    const eliminatedUserIds = new Set<string>();
    rounds.forEach((round) => {
      round.eliminationLogs.forEach((log) => {
        eliminatedUserIds.add(log.userId);
      });
    });
    const survivorCount = Math.max(0, playerCount - eliminatedUserIds.size);

    const latestRound = rounds[rounds.length - 1];
    const latestRoundMetadata = (latestRound?.metadata as Record<string, unknown>) ?? {};
    const latestChoices = (latestRoundMetadata.playerChoices as Array<{ stake?: number }>) ?? [];
    const currentPot = latestChoices.reduce((sum: number, p) => sum + (p.stake ?? 0), 0);

    let yieldAccrued = 0;
    rounds.forEach((round) => {
      if (round.state === "RESOLVED") {
        const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
        const roundYield = (roundMetadata.oracleYield as number | undefined) ?? 0;
        yieldAccrued += roundYield;
      }
    });

    const status = latestRound?.state ?? "pending";

    return {
      arenaId,
      arenaName,
      currentPot,
      playerCount,
      maxPlayers,
      survivorCount,
      currentRound,
      entryFee,
      stakeToken,
      joinDeadline,
      yieldAccrued,
      status: status.toLowerCase(),
      lastUpdated: new Date().toISOString(),
    };
  }
}
