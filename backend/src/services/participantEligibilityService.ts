import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import type { PlayerStatusReader } from "./playerStatus";
import type { OnChainReadResult } from "../types/onChainRead";

const ELIGIBILITY_SNAPSHOT_TTL_MS = 10_000;
const MAX_ELIGIBILITY_SNAPSHOTS = 5_000;

export type PlayerCountReader = (contractId: string) => Promise<OnChainReadResult<number>>;

export interface EligibilityCheckResult {
  isEligible: boolean;
  errors: EligibilityError[];
  warnings: string[];
  snapshot: {
    id: string;
    network: string;
    ledgerSequence: number;
    verifiedAt: string;
    expiresAt: string;
  } | null;
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
  private readonly snapshots = new Map<string, {
    ownerWallet: string;
    arenaId: string;
    expiresAtMs: number;
    result: EligibilityCheckResult;
  }>();

  constructor(
    private prisma: PrismaClient,
    private readPlayerStatus: PlayerStatusReader,
    private readPlayerCount?: PlayerCountReader,
  ) {}

  /**
   * Perform a comprehensive eligibility check before join transaction construction.
   *
   * Checks:
   * - Capacity: Arena is not full
   * - Phase: Arena is in its lobby (on-chain `get_player_status`, #1582)
   * - Balance: Player has sufficient balance for stake
   * - Token: Correct token type for arena
   * - Duplicate membership: Player not already joined (on-chain, #1582)
   *
   * The arena id is its contract address, so membership and phase come from
   * the contract rather than from indexed rows that can lag the chain.
   */
  async checkEligibility(
    arenaId: string,
    playerWallet: string,
    playerBalance: number,
    balanceAsset: "USDC" | "XLM" | "EURC",
  ): Promise<EligibilityCheckResult> {
    const errors: EligibilityError[] = [];
    const warnings: string[] = [];

    const arena = await this.prisma.arena.findUnique({ where: { id: arenaId } });

    if (!arena) {
      return {
        isEligible: false,
        snapshot: null,
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

    let currentPlayers = this.readPlayerCount ? 0 : await this.getCurrentPlayerCount(arenaId);
    const [statusRead, playerCountRead] = await Promise.all([
      this.readPlayerStatus(arenaId, playerWallet),
      this.readPlayerCount?.(arenaId) ?? Promise.resolve(null),
    ]);
    const statusHasVerifiedBoundary =
      statusRead.outcome === "verified" &&
      statusRead.provenance.ledgerSequence !== null &&
      Number.isInteger(statusRead.provenance.ledgerSequence) &&
      statusRead.provenance.ledgerSequence >= 0 &&
      statusRead.provenance.network.length > 0;
    const countHasVerifiedBoundary =
      playerCountRead?.outcome === "verified" &&
      playerCountRead.provenance.ledgerSequence !== null &&
      Number.isInteger(playerCountRead.provenance.ledgerSequence) &&
      playerCountRead.provenance.network.length > 0 &&
      Number.isInteger(playerCountRead.value) &&
      playerCountRead.value >= 0;
    const boundariesMatch =
      !this.readPlayerCount ||
      (statusHasVerifiedBoundary &&
        countHasVerifiedBoundary &&
        statusRead.outcome === "verified" &&
        playerCountRead?.outcome === "verified" &&
        statusRead.provenance.network === playerCountRead.provenance.network &&
        statusRead.provenance.ledgerSequence === playerCountRead.provenance.ledgerSequence);
    const hasVerifiedBoundary = statusHasVerifiedBoundary && boundariesMatch;
    if (playerCountRead?.outcome === "verified") currentPlayers = playerCountRead.value;
    const boundaryUnavailable = statusRead.outcome === "verified" && !hasVerifiedBoundary;
    const status = hasVerifiedBoundary && statusRead.outcome === "verified"
      ? statusRead.value
      : null;
    const arenaPhase = status?.phase ?? "UNKNOWN";
    const requiredStake = arena.entryFee;

    // Check 1: Capacity
    if (currentPlayers >= arena.maxPlayers) {
      errors.push({
        code: "ARENA_FULL",
        message: `Arena has reached maximum capacity (${arena.maxPlayers} players)`,
        severity: "error",
      });
    }

    // Check 2: Phase - only the lobby accepts joins. An unreadable status is
    // a failure, never an assumed-joinable arena.
    if (!status) {
      errors.push({
        code: boundaryUnavailable ? "LEDGER_BOUNDARY_UNAVAILABLE" : "PLAYER_STATUS_UNAVAILABLE",
        message: boundaryUnavailable
          ? "Could not verify the ledger boundary for this eligibility snapshot; try again"
          : "Could not read the player's on-chain arena status; try again",
        severity: "error",
      });
    } else if (status.phase !== "Lobby") {
      errors.push({
        code: "ARENA_NOT_JOINABLE",
        message: `Arena is in ${arenaPhase} phase and cannot accept new players`,
        severity: "error",
      });
    }
    if (this.readPlayerCount && playerCountRead?.outcome !== "verified") {
      errors.push({
        code: "PLAYER_COUNT_UNAVAILABLE",
        message: "Could not verify the arena player count; try again",
        severity: "error",
      });
    } else if (this.readPlayerCount && !boundariesMatch) {
      errors.push({
        code: "LEDGER_BOUNDARY_MISMATCH",
        message: "Arena eligibility reads came from different ledgers; try again",
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

    // Check 6: Duplicate membership
    if (status?.joined) {
      errors.push({
        code: "DUPLICATE_MEMBERSHIP",
        message: "This wallet address is already participating in this arena",
        severity: "error",
      });
    }

    // Check 7: Network mismatch warning
    if (balanceAsset === "XLM") {
      warnings.push("XLM transactions include network fees; ensure sufficient balance");
    }

    // Check 8: Concurrent request warning
    if (currentPlayers > arena.maxPlayers * 0.8) {
      warnings.push("Arena is nearly full; other players may be joining simultaneously");
    }

    const result: EligibilityCheckResult = {
      isEligible: errors.length === 0,
      errors,
      warnings,
      snapshot: null,
      metadata: {
        currentPlayers,
        maxPlayers: arena.maxPlayers,
        arenaPhase,
        playerBalance,
        requiredStake,
      },
    };
    if (status && hasVerifiedBoundary && statusRead.outcome === "verified") {
      const expiresAtMs = Date.now() + ELIGIBILITY_SNAPSHOT_TTL_MS;
      const snapshot = {
        id: randomUUID(),
        network: statusRead.provenance.network,
        ledgerSequence: statusRead.provenance.ledgerSequence!,
        verifiedAt: statusRead.provenance.observedAt,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      result.snapshot = snapshot;
      this.snapshots.set(snapshot.id, {
        ownerWallet: playerWallet,
        arenaId,
        expiresAtMs,
        result: this.cloneResult(result),
      });
      this.pruneSnapshots();
    }
    return result;
  }

  /** Retrieve a previously verified, short-lived snapshot without another RPC read. */
  getSnapshot(snapshotId: string, arenaId: string, playerWallet: string): EligibilityCheckResult | null {
    const snapshot = this.snapshots.get(snapshotId);
    if (
      !snapshot ||
      snapshot.arenaId !== arenaId ||
      snapshot.ownerWallet !== playerWallet ||
      snapshot.expiresAtMs <= Date.now()
    ) {
      this.snapshots.delete(snapshotId);
      return null;
    }
    return this.cloneResult(snapshot.result);
  }

  /** Mutation callers must use a live verified read, never the reusable snapshot cache. */
  checkFreshEligibility(
    arenaId: string,
    playerWallet: string,
    playerBalance: number,
    balanceAsset: "USDC" | "XLM" | "EURC",
  ): Promise<EligibilityCheckResult> {
    return this.checkEligibility(arenaId, playerWallet, playerBalance, balanceAsset);
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

  private pruneSnapshots(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAtMs <= now) this.snapshots.delete(id);
    }
    while (this.snapshots.size > MAX_ELIGIBILITY_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }

  private cloneResult(result: EligibilityCheckResult): EligibilityCheckResult {
    return {
      ...result,
      snapshot: result.snapshot ? { ...result.snapshot } : null,
      errors: result.errors.map((error) => ({ ...error })),
      warnings: [...result.warnings],
      metadata: { ...result.metadata },
    };
  }
}
