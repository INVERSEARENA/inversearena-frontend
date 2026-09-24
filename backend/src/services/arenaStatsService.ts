import { PrismaClient } from "@prisma/client";
import { ArenaStats } from "../types/arena";
import {
  getOnChainSnapshotOrThrow,
  mapGameStateToStatus,
  type OnChainArenaSnapshot,
} from "./onChainReader";
import { getCurrentLedgerSequence } from "./ledgerClock";
import { getSorobanBreaker } from "../utils/circuitBreaker";
import { cache, cacheKeys, cacheTTL } from "../cache/cacheService";
import { logger } from "../utils/logger";

interface VerifiedOnChainSnapshot extends OnChainArenaSnapshot {
  ledgerSequence: number;
  verifiedAt: string;
}

export class ArenaStatsService {
  constructor(private prisma: PrismaClient) {}

  async getArenaStats(arenaId: string): Promise<ArenaStats> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      include: {
        // Round-level fields (state/metadata) are needed across the *whole*
        // history — yield fallback and SETTLED detection both scan every
        // round, not just the latest — so we still fetch all rounds. But
        // eliminationLogs was pulling every elimination row's full content
        // into memory (id, reason, eliminatedAt, ...) just to read distinct
        // userIds; that's fetched separately below via a single distinct
        // query instead, which Prisma can satisfy without materializing
        // full row objects for a long-running arena's entire history.
        rounds: {
          orderBy: { roundNumber: "asc" },
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

    // ── #1408: One combined, all-or-nothing on-chain read ─────────────────
    // Previously player count / yield / status each had their own try/catch
    // that silently fell back to a DB-derived value with no signal to the
    // caller — a partial RPC hiccup could mix live and stale fields with
    // nothing to tell them apart. Now: either all three come from a single
    // live read (degraded=false), or — if that fails — all three come from
    // the last verified snapshot (degraded=true, with the ledger it was
    // verified at), or — if there has never been a successful read for this
    // arena — all three fall back to the pre-#1408 DB-derived values,
    // unflagged, exactly as before.
    const contractAddress = metadata.contractAddress as string | undefined;
    const vaultContractAddress =
      (metadata.vaultContractAddress as string | undefined) ?? contractAddress;

    let onChainOverlay: VerifiedOnChainSnapshot | null = null;
    let degraded = false;

    if (contractAddress && vaultContractAddress) {
      try {
        onChainOverlay = await this.fetchAndCacheOnChainSnapshot(
          arenaId,
          contractAddress,
          vaultContractAddress,
        );
      } catch (err) {
        const cached = await cache.get<VerifiedOnChainSnapshot>(
          cacheKeys.arenaOnChainSnapshot(arenaId),
        );
        if (cached) {
          logger.warn(
            {
              subsystem: "arena-stats",
              arenaId,
              err: err instanceof Error ? err.message : String(err),
              snapshotLedgerSequence: cached.ledgerSequence,
            },
            "Live on-chain read failed; serving last verified snapshot",
          );
          onChainOverlay = cached;
          degraded = true;
        }
        // No snapshot has ever been verified for this arena — fall through
        // to the DB-derived values below, matching pre-#1408 behavior.
      }
    }

    const playerCount = onChainOverlay
      ? onChainOverlay.playerCount
      : await this.prisma.pool.count({ where: { arenaId } });

    const eliminatedCount = await this.prisma.eliminationLog
      .findMany({
        where: { round: { arenaId } },
        distinct: ["userId"],
        select: { userId: true },
      })
      .then((rows) => rows.length);
    const survivorCount = Math.max(0, playerCount - eliminatedCount);

    const latestRound = rounds[rounds.length - 1];
    const latestRoundMetadata = (latestRound?.metadata as Record<string, unknown>) ?? {};
    const latestChoices = (latestRoundMetadata.playerChoices as Array<{ stake?: number }>) ?? [];
    const currentPot = latestChoices.reduce((sum: number, p) => sum + (p.stake ?? 0), 0);

    let yieldAccrued: number;
    if (onChainOverlay) {
      yieldAccrued = onChainOverlay.yieldAccrued;
    } else {
      yieldAccrued = 0;
      rounds.forEach((round) => {
        if (round.state === "RESOLVED") {
          const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
          const roundYield = (roundMetadata.oracleYield as number | undefined) ?? 0;
          yieldAccrued += roundYield;
        }
      });
    }

    // Check if prize has been claimed by looking for a SETTLED round — this
    // is DB state either way, live read or degraded snapshot.
    const prizeClaimed = rounds.some((r) => r.state === "SETTLED");
    const status = onChainOverlay
      ? mapGameStateToStatus(onChainOverlay.gameState, prizeClaimed)
      : this.deriveStatusFromRounds(rounds);

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
      degraded,
      ledgerSequence: onChainOverlay?.ledgerSequence ?? null,
      snapshotVerifiedAt: onChainOverlay?.verifiedAt ?? null,
    };
  }

  /**
   * Attempt a live on-chain read; on success, persist it as the new "last
   * verified" snapshot so a future failed read has something to degrade to.
   */
  private async fetchAndCacheOnChainSnapshot(
    arenaId: string,
    contractAddress: string,
    vaultContractAddress: string,
  ): Promise<VerifiedOnChainSnapshot> {
    const [snapshot, ledgerSequence] = await Promise.all([
      getSorobanBreaker().fire(() => getOnChainSnapshotOrThrow(contractAddress, vaultContractAddress)),
      getCurrentLedgerSequence(), // already circuit-breaker-wrapped internally
    ]);

    const verified: VerifiedOnChainSnapshot = {
      ...snapshot,
      ledgerSequence,
      verifiedAt: new Date().toISOString(),
    };

    await cache.set(
      cacheKeys.arenaOnChainSnapshot(arenaId),
      verified,
      cacheTTL.ARENA_ONCHAIN_SNAPSHOT,
    );

    return verified;
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
        return "resolved";
      case "SETTLED":
        return "settled";
      default:
        return roundState.toLowerCase();
    }
  }
}
