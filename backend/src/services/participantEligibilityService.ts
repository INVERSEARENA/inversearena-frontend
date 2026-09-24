import { PrismaClient } from "@prisma/client";
import type { Arena } from "@prisma/client";

export interface EligibilityCheckResult {
  isEligible: boolean;
  errors: EligibilityError[];
  warnings: string[];
  metadata: {
    currentPlayers: number;
    maxPlayers: number;
    arenaPhase: string;
    playerBalance: number;
    requiredStake: number;
  };
}

export interface EligibilityError {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export class ParticipantEligibilityService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Perform a comprehensive eligibility check before join transaction construction.
   *
   * Checks:
   * - Capacity: Arena is not full
   * - Phase: Arena is in joinable phase
   * - Balance: Player has sufficient balance for stake
   * - Token: Correct token type for arena
   * - Duplicate membership: Player not already in arena
   */
  async checkEligibility(
    arenaId: string,
    playerWallet: string,
    playerBalance: number,
    balanceAsset: "USDC" | "XLM" | "EURC",
  ): Promise<EligibilityCheckResult> {
    const errors: EligibilityError[] = [];
    const warnings: string[] = [];

    // Fetch arena and latest round info
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      include: {
        rounds: {
          orderBy: { roundNumber: "desc" },
          take: 1,
        },
      },
    });

    if (!arena) {
      return {
        isEligible: false,
        errors: [
          {
            code: "ARENA_NOT_FOUND",
            message: `Arena ${arenaId} not found`,
            severity: "error",
          },
        ],
        warnings: [],
        metadata: {
          currentPlayers: 0,
          maxPlayers: 0,
          arenaPhase: "UNKNOWN",
          playerBalance: 0,
          requiredStake: 0,
        },
      };
    }

    const latestRound = arena.rounds[0];
    const currentPlayers = await this.getCurrentPlayerCount(arenaId);
    const arenaPhase = this.determineArenaPhase(arena, latestRound);
    const requiredStake = arena.entryFee;

    // Check 1: Capacity
    if (currentPlayers >= arena.maxPlayers) {
      errors.push({
        code: "ARENA_FULL",
        message: `Arena has reached maximum capacity (${arena.maxPlayers} players)`,
        severity: "error",
      });
    }

    // Check 2: Phase - joinable phases are WAITING or RECRUITING
    if (arenaPhase !== "WAITING" && arenaPhase !== "RECRUITING") {
      errors.push({
        code: "ARENA_NOT_JOINABLE",
        message: `Arena is in ${arenaPhase} phase and cannot accept new players`,
        severity: "error",
      });
    }

    // Check 3: Join deadline
    const now = new Date();
    if (arena.joinDeadline && new Date(arena.joinDeadline) < now) {
      errors.push({
        code: "JOIN_DEADLINE_PASSED",
        message: "The arena join deadline has passed",
        severity: "error",
      });
    }

    // Check 4: Token mismatch
    if (balanceAsset !== arena.stakeToken) {
      errors.push({
        code: "TOKEN_MISMATCH",
        message: `Arena requires ${arena.stakeToken}, but ${balanceAsset} was provided`,
        severity: "error",
      });
    }

    // Check 5: Balance
    if (playerBalance < requiredStake) {
      errors.push({
        code: "INSUFFICIENT_BALANCE",
        message: `Insufficient balance. Required: ${requiredStake} ${balanceAsset}, Available: ${playerBalance} ${balanceAsset}`,
        severity: "error",
      });
    }

    // Check 6: Duplicate membership - player already in current round
    if (latestRound) {
      const existingParticipant = await this.prisma.arenaParticipant.findUnique({
        where: {
          roundId_walletAddress: {
            roundId: latestRound.id,
            walletAddress: playerWallet,
          },
        },
      });

      if (existingParticipant) {
        errors.push({
          code: "DUPLICATE_MEMBERSHIP",
          message: "This wallet address is already participating in this arena",
          severity: "error",
        });
      }
    }

    // Check 7: Network mismatch warning
    if (balanceAsset === "XLM") {
      warnings.push("XLM transactions include network fees; ensure sufficient balance");
    }

    // Check 8: Concurrent request warning
    if (currentPlayers > arena.maxPlayers * 0.8) {
      warnings.push("Arena is nearly full; other players may be joining simultaneously");
    }

    return {
      isEligible: errors.length === 0,
      errors,
      warnings,
      metadata: {
        currentPlayers,
        maxPlayers: arena.maxPlayers,
        arenaPhase,
        playerBalance,
        requiredStake,
      },
    };
  }

  /**
   * Get current number of active players in an arena.
   * Counts unique wallets in the latest round.
   */
  private async getCurrentPlayerCount(arenaId: string): Promise<number> {
    const latestRound = await this.prisma.round.findFirst({
      where: { arenaId },
      orderBy: { roundNumber: "desc" },
      select: { id: true },
    });

    if (!latestRound) {
      return 0;
    }

    const count = await this.prisma.arenaParticipant.count({
      where: {
        roundId: latestRound.id,
        isEliminated: false,
      },
    });

    return count;
  }

  /**
   * Determine the phase of an arena based on current time and latest round state.
   */
  private determineArenaPhase(
    arena: Arena,
    latestRound: { state: string } | undefined,
  ): string {
    const now = new Date();

    if (arena.resolvedAt && new Date(arena.resolvedAt) < now) {
      return "SETTLED";
    }

    if (latestRound) {
      if (latestRound.state === "ACTIVE") {
        return "ACTIVE";
      }
      if (latestRound.state === "RESOLVED") {
        return "ROUND_RESOLVED";
      }
    }

    if (arena.joinDeadline && new Date(arena.joinDeadline) < now) {
      return "CLOSED";
    }

    return "WAITING";
  }
}
