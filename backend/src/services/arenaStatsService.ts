import { PrismaClient } from "@prisma/client";
import { ArenaStats } from "../types/arena";
import {
  getOnChainGameState,
  getOnChainPlayerCount,
  getOnChainTotalYield,
  mapGameStateToStatus,
} from "./onChainReader";

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

    // ── #1119: Read player count from on-chain contract ──────────────────
    // The contract's get_player_count() reflects ALL players who joined,
    // including those who called the contract directly (not via backend API).
    // Fall back to DB row count if the on-chain call fails.
    const contractAddress = metadata.contractAddress as string | undefined;
    let playerCount: number;
    if (contractAddress) {
      try {
        playerCount = await getOnChainPlayerCount(contractAddress);
      } catch {
        // Fallback to DB count if on-chain read fails
        playerCount = await this.prisma.pool.count({ where: { arenaId } });
      }
    } else {
      playerCount = await this.prisma.pool.count({ where: { arenaId } });
    }

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

    // ── #1120: Source yieldAccrued from on-chain rwa-adapter vault ─────────
    // The previous implementation summed the oracleYield column from DB records,
    // which is disconnected from actual on-chain token flows. Now we attempt
    // to read from the rwa-adapter vault's get_total_yield if available.
    let yieldAccrued = 0;
    const vaultContractAddress = (metadata.vaultContractAddress as string | undefined) ?? contractAddress;
    if (vaultContractAddress) {
      try {
        yieldAccrued = await getOnChainTotalYield(vaultContractAddress);
      } catch {
        // Fallback to DB-based calculation if on-chain read fails
        rounds.forEach((round) => {
          if (round.state === "RESOLVED") {
            const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
            const roundYield = (roundMetadata.oracleYield as number | undefined) ?? 0;
            yieldAccrued += roundYield;
          }
        });
      }
    } else {
      // No contract address available, use DB-based calculation
      rounds.forEach((round) => {
        if (round.state === "RESOLVED") {
          const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
          const roundYield = (roundMetadata.oracleYield as number | undefined) ?? 0;
          yieldAccrued += roundYield;
        }
      });
    }

    // ── #1124: Derive status from on-chain game_state() ──────────────────
    // The previous implementation only used latestRound.state which only
    // returns "OPEN"/"CLOSED"/"RESOLVED"/"SETTLED" — never the terminal
    // arena states. Now we check the contract's game_state() to detect
    // Finished and Cancelled arenas.
    let status: string;
    if (contractAddress) {
      try {
        const gameState = await getOnChainGameState(contractAddress);
        // Check if prize has been claimed by looking for a SETTLED round
        const prizeClaimed = rounds.some((r) => r.state === "SETTLED");
        status = mapGameStateToStatus(gameState, prizeClaimed);
      } catch {
        // Fallback to round-based status derivation
        status = this.deriveStatusFromRounds(rounds);
      }
    } else {
      status = this.deriveStatusFromRounds(rounds);
    }

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
      status,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Fallback status derivation from round states when on-chain read is unavailable.
   */
  private deriveStatusFromRounds(
    rounds: Array<{ state: string }>,
  ): string {
    if (rounds.length === 0) return "pending";

    const latestRound = rounds[rounds.length - 1]!;
    const roundState = latestRound.state;

    // If any round is SETTLED, the arena is settled
    if (rounds.some((r) => r.state === "SETTLED")) return "settled";

    // Otherwise map round state to arena status
    switch (roundState) {
      case "OPEN":
        return "active";
      case "CLOSED":
        return "active";
      case "RESOLVED":
        return "active";
      case "SETTLED":
        return "settled";
      default:
        return roundState.toLowerCase();
    }
  }
}
