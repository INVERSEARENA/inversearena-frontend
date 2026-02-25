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

    const metadata = (arena.metadata as Record<string, any>) || {};
    const entryFee = metadata.minStake || 0;

    const rounds = arena.rounds;
    const currentRound = rounds.length > 0 ? rounds[rounds.length - 1].roundNumber : 0;

    // Player count is based on the first round's participation
    // If no rounds have started, it's 0 or we could check pools in a real scenario
    // For this implementation, we rely on the first round's metadata or a placeholder
    const firstRound = rounds[0];
    const firstRoundMetadata = (firstRound?.metadata as Record<string, any>) || {};
    const playerChoices = firstRoundMetadata.playerChoices || [];
    const playerCount = playerChoices.length;

    // Survivor count is playerCount minus total unique eliminations
    const eliminatedUserIds = new Set<string>();
    rounds.forEach((round) => {
      round.eliminationLogs.forEach((log) => {
        eliminatedUserIds.add(log.userId);
      });
    });
    const survivorCount = Math.max(0, playerCount - eliminatedUserIds.size);

    // Current pot comes from the latest round's choices
    const latestRound = rounds[rounds.length - 1];
    const latestRoundMetadata = (latestRound?.metadata as Record<string, any>) || {};
    const latestChoices = latestRoundMetadata.playerChoices || [];
    const currentPot = latestChoices.reduce((sum: number, p: any) => sum + (p.stake || 0), 0);

    // Yield accrued can be derived from round resolutions or oracle yield
    // For simplicity, we aggregate oracleYield from all resolved rounds
    let yieldAccrued = 0;
    rounds.forEach((round) => {
      if (round.state === "RESOLVED") {
          const roundMetadata = (round.metadata as Record<string, any>) || {};
          const roundYield = roundMetadata.oracleYield || 0;
          // Simple additive yield for this mock-to-real transition
          yieldAccrued += roundYield; 
      }
    });

    const status = latestRound?.state || "pending";

    return {
      arenaId,
      currentPot,
      playerCount,
      survivorCount,
      currentRound,
      entryFee,
      yieldAccrued,
      status: status.toLowerCase(),
      lastUpdated: new Date().toISOString(),
    };
  }
}
