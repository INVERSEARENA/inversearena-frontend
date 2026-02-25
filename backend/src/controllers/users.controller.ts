import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { UserModel } from "../db/models/user.model";

export class UsersController {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * GET /api/users/me
   *
   * Returns the authenticated user's identity (from MongoDB) plus
   * aggregated game stats (from PostgreSQL via Prisma).
   *
   * Stats returned:
   *  - gamesPlayed  — distinct arenas the user participated in
   *  - gamesWon     — arenas where the user was never eliminated
   *  - totalYieldEarned — sum of payouts from resolved rounds (USDC string)
   *  - currentRank  — 1-based position on the all-time yield leaderboard (null if unranked)
   */
  me = async (req: Request, res: Response): Promise<void> => {
    const { id, walletAddress } = req.user!;

    // ── Identity (MongoDB) ──────────────────────────────────────────
    const user = await UserModel.findById(id).lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // ── Game stats (PostgreSQL / Prisma) ────────────────────────────
    const stats = await this.aggregateStats(id);

    res.json({
      id: user._id.toString(),
      walletAddress: user.walletAddress,
      displayName: user.displayName ?? null,
      joinedAt: user.joinedAt,
      lastLoginAt: user.lastLoginAt,
      ...stats,
    });
  };

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  private async aggregateStats(userId: string) {
    // Gather all data in parallel for speed
    const [gamesPlayed, gamesWon, totalYieldEarned, currentRank] =
      await Promise.all([
        this.countGamesPlayed(userId),
        this.countGamesWon(userId),
        this.sumYieldEarned(userId),
        this.computeRank(userId),
      ]);

    return {
      gamesPlayed,
      gamesWon,
      totalYieldEarned: totalYieldEarned.toFixed(2),
      currentRank,
    };
  }

  /**
   * Count of distinct arenas the user participated in.
   * A "participation" is evidenced by appearing in any round's metadata
   * (playerChoices) or in the elimination_logs table.
   */
  private async countGamesPlayed(userId: string): Promise<number> {
    // Elimination logs directly link userId → roundId → arenaId.
    // This gives us arenas where the user was eliminated at least once,
    // plus we check resolved rounds' metadata for non-eliminated participation.
    const eliminationArenas = await this.prisma.eliminationLog.findMany({
      where: { userId },
      select: {
        round: { select: { arenaId: true } },
      },
    });

    const arenaIds = new Set(
      eliminationArenas.map(
        (e: { round: { arenaId: string } }) => e.round.arenaId,
      ),
    );

    // Also check rounds where userId appears in metadata (playerChoices)
    const resolvedRounds = await this.prisma.round.findMany({
      where: { state: "RESOLVED" },
      select: { arenaId: true, metadata: true },
    });

    for (const round of resolvedRounds) {
      const meta = round.metadata as Record<string, unknown> | null;
      if (!meta) continue;
      const choices = meta.playerChoices as
        | Array<{ userId: string }>
        | undefined;
      if (choices?.some((c) => c.userId === userId)) {
        arenaIds.add(round.arenaId);
      }
    }

    return arenaIds.size;
  }

  /**
   * Arenas where the user participated but was *never* eliminated.
   */
  private async countGamesWon(userId: string): Promise<number> {
    // All arenas user participated in (from resolved round metadata)
    const resolvedRounds = await this.prisma.round.findMany({
      where: { state: "RESOLVED" },
      select: { arenaId: true, metadata: true },
    });

    const participatedArenaIds = new Set<string>();
    for (const round of resolvedRounds) {
      const meta = round.metadata as Record<string, unknown> | null;
      if (!meta) continue;
      const choices = meta.playerChoices as
        | Array<{ userId: string }>
        | undefined;
      if (choices?.some((c) => c.userId === userId)) {
        participatedArenaIds.add(round.arenaId);
      }
    }

    if (participatedArenaIds.size === 0) return 0;

    // Arenas where the user was eliminated at least once
    const eliminations = await this.prisma.eliminationLog.findMany({
      where: { userId },
      select: { round: { select: { arenaId: true } } },
    });

    const eliminatedArenaIds = new Set(
      eliminations.map((e: { round: { arenaId: string } }) => e.round.arenaId),
    );

    // Won = participated but never eliminated
    let won = 0;
    for (const arenaId of participatedArenaIds) {
      if (!eliminatedArenaIds.has(arenaId)) {
        won++;
      }
    }

    return won;
  }

  /**
   * Sum of payouts the user received across all resolved rounds.
   */
  private async sumYieldEarned(userId: string): Promise<number> {
    const resolvedRounds = await this.prisma.round.findMany({
      where: { state: "RESOLVED" },
      select: { metadata: true },
    });

    let totalYield = 0;

    for (const round of resolvedRounds) {
      const meta = round.metadata as Record<string, unknown> | null;
      if (!meta) continue;

      const resolution = meta.resolution as
        | { payouts?: Array<{ userId: string; amount: number }> }
        | undefined;
      if (!resolution?.payouts) continue;

      const payout = resolution.payouts.find((p) => p.userId === userId);
      if (payout) {
        totalYield += payout.amount;
      }
    }

    return totalYield;
  }

  /**
   * 1-based leaderboard position based on total yield earned.
   * Returns null when the user has zero yield (unranked).
   */
  private async computeRank(userId: string): Promise<number | null> {
    const resolvedRounds = await this.prisma.round.findMany({
      where: { state: "RESOLVED" },
      select: { metadata: true },
    });

    // Accumulate per-user yield
    const yieldByUser = new Map<string, number>();

    for (const round of resolvedRounds) {
      const meta = round.metadata as Record<string, unknown> | null;
      if (!meta) continue;

      const resolution = meta.resolution as
        | { payouts?: Array<{ userId: string; amount: number }> }
        | undefined;
      if (!resolution?.payouts) continue;

      for (const p of resolution.payouts) {
        yieldByUser.set(p.userId, (yieldByUser.get(p.userId) ?? 0) + p.amount);
      }
    }

    const userYield = yieldByUser.get(userId) ?? 0;
    if (userYield === 0) return null;

    // Rank = 1 + number of users with strictly higher yield
    let rank = 1;
    for (const [, total] of yieldByUser) {
      if (total > userYield) rank++;
    }

    return rank;
  }
}
