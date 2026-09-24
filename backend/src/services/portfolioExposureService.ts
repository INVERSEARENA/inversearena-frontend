/**
 * Portfolio Exposure Service (#1397)
 *
 * Provides portfolio-level exposure summary across active arenas.
 * Totals reconcile with per-arena principal, pending claims, and realized rewards.
 */

import { PrismaClient, type Arena, type Round, type Pool } from "@prisma/client";
import { getOnChainPlayerCount, getOnChainTotalYield } from "./onChainReader";

export interface ArenaExposure {
  arenaId: string;
  arenaName: string;
  principal: number;
  pendingClaims: number;
  realizedRewards: number;
  status: string;
  playerCount: number;
  currentRound: number;
}

export interface PortfolioExposure {
  userId: string;
  totalPrincipal: number;
  totalPendingClaims: number;
  totalRealizedRewards: number;
  totalExposure: number;
  arenas: ArenaExposure[];
  lastUpdated: string;
}

export class PortfolioExposureService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get portfolio-level exposure summary for a user across all active arenas.
   */
  async getPortfolioExposure(userId: string): Promise<PortfolioExposure> {
    // Get all arenas where the user has participated
    const userParticipations = await this.prisma.round.findMany({
      where: {
        metadata: {
          path: ["playerChoices"],
          array_contains: [{ userId }],
        },
      },
      select: {
        arenaId: true,
      },
      distinct: ["arenaId"],
    });

    const arenaIds = userParticipations.map((p) => p.arenaId);

    if (arenaIds.length === 0) {
      return {
        userId,
        totalPrincipal: 0,
        totalPendingClaims: 0,
        totalRealizedRewards: 0,
        totalExposure: 0,
        arenas: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    // Get all arenas with their rounds
    const arenas = await this.prisma.arena.findMany({
      where: { id: { in: arenaIds } },
      include: {
        rounds: {
          orderBy: { roundNumber: "asc" },
        },
      },
    });

    const arenaExposures: ArenaExposure[] = [];
    let totalPrincipal = 0;
    let totalPendingClaims = 0;
    let totalRealizedRewards = 0;

    for (const arena of arenas) {
      const metadata = (arena.metadata as Record<string, unknown>) ?? {};
      const entryFee = (metadata.entryFee as number) ?? 0;
      const contractAddress = (metadata.contractAddress as string) ?? "";
      const arenaName = (metadata.name as string) ?? `Arena ${arena.id.slice(0, 8)}`;

      // Calculate user's principal in this arena
      let principal = 0;
      let pendingClaims = 0;
      let realizedRewards = 0;

      for (const round of arena.rounds) {
        const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
        const playerChoices = (roundMetadata.playerChoices as Array<{ userId: string; stake: number }>) ?? [];

        // Find user's choice in this round
        const userChoice = playerChoices.find((c) => c.userId === userId);
        if (userChoice) {
          principal += userChoice.stake;

          // Check if round is resolved and user won
          if (round.state === "RESOLVED" || round.state === "SETTLED") {
            const resolution = (roundMetadata.resolution as Record<string, unknown>) ?? {};
            const payouts = (resolution.payouts as Array<{ userId: string; amount: number }>) ?? [];
            const userPayout = payouts.find((p) => p.userId === userId);

            if (userPayout) {
              realizedRewards += userPayout.amount;
            } else {
              // User was eliminated, stake is lost
              pendingClaims += 0;
            }
          } else {
            // Round still in progress, stake is pending
            pendingClaims += userChoice.stake;
          }
        }
      }

      // Get player count from on-chain or fallback to DB
      let playerCount = 0;
      if (contractAddress) {
        try {
          playerCount = await getOnChainPlayerCount(contractAddress);
        } catch {
          playerCount = await this.prisma.pool.count({ where: { arenaId: arena.id } });
        }
      } else {
        playerCount = await this.prisma.pool.count({ where: { arenaId: arena.id } });
      }

      // Determine status
      let status = "active";
      const lastRound = arena.rounds[arena.rounds.length - 1];
      if (lastRound) {
        if (lastRound.state === "SETTLED") status = "settled";
        else if (lastRound.state === "RESOLVED") status = "resolved";
      }

      arenaExposures.push({
        arenaId: arena.id,
        arenaName,
        principal,
        pendingClaims,
        realizedRewards,
        status,
        playerCount,
        currentRound: lastRound?.roundNumber ?? 0,
      });

      totalPrincipal += principal;
      totalPendingClaims += pendingClaims;
      totalRealizedRewards += realizedRewards;
    }

    return {
      userId,
      totalPrincipal,
      totalPendingClaims,
      totalRealizedRewards,
      totalExposure: totalPrincipal + totalPendingClaims,
      arenas: arenaExposures,
      lastUpdated: new Date().toISOString(),
    };
  }
}
