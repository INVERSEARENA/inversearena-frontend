import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

// ── Query param validation ──────────────────────────────────────────
const LeaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// ── Response shape (matches frontend Survivor type) ─────────────────
export interface PlayerStats {
  id: string;
  rank: number;
  walletAddress: string;
  survivalStreak: number;
  totalYield: number;
  arenasWon: number;
}

interface DecodedCursor {
  offset: number;
}

// ── Controller ──────────────────────────────────────────────────────
export class LeaderboardController {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * GET /api/leaderboard
   *
   * Returns paginated leaderboard of players ranked by total yield earned.
   *
   * Query params:
   *  - limit  (1–100, default 20)
   *  - cursor (opaque base64 string for pagination, omit for first page)
   *
   * Response:
   *  {
   *    players: PlayerStats[],
   *    nextCursor: string | null
   *  }
   */
  getLeaderboard = async (req: Request, res: Response): Promise<void> => {
    const { limit, cursor } = LeaderboardQuerySchema.parse(req.query);

    const offset = cursor ? this.decodeCursor(cursor) : 0;

    // ── Build the full ranked list ──────────────────────────────────
    const rankedPlayers = await this.buildRankedPlayers();

    // ── Paginate ────────────────────────────────────────────────────
    const page = rankedPlayers.slice(offset, offset + limit);
    const hasMore = offset + limit < rankedPlayers.length;
    const nextCursor = hasMore ? this.encodeCursor(offset + limit) : null;

    res.json({
      players: page,
      nextCursor,
    });
  };

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Aggregates all users' stats from resolved rounds and elimination logs,
   * returning a sorted array of players ranked by total yield (descending).
   *
   * - totalYield     : sum of payouts from round resolution metadata
   * - arenasWon      : distinct arenas where user participated but was never eliminated
   * - survivalStreak : rounds participated minus rounds eliminated (cumulative)
   */
  private async buildRankedPlayers(): Promise<PlayerStats[]> {
    // 1. Fetch all resolved rounds
    const resolvedRounds = await this.prisma.round.findMany({
      where: { state: "RESOLVED" },
      select: { arenaId: true, metadata: true },
    });

    // Per-user accumulators
    const yieldByUser = new Map<string, number>();
    const arenasByUser = new Map<string, Set<string>>();
    const roundsParticipatedByUser = new Map<string, number>();

    for (const round of resolvedRounds) {
      const meta = round.metadata as Record<string, unknown> | null;
      if (!meta) continue;

      const choices = meta.playerChoices as
        | Array<{ userId: string }>
        | undefined;
      if (choices) {
        for (const c of choices) {
          if (!arenasByUser.has(c.userId)) arenasByUser.set(c.userId, new Set());
          arenasByUser.get(c.userId)!.add(round.arenaId);
          roundsParticipatedByUser.set(
            c.userId,
            (roundsParticipatedByUser.get(c.userId) ?? 0) + 1,
          );
        }
      }

      const resolution = meta.resolution as
        | { payouts?: Array<{ userId: string; amount: number }> }
        | undefined;
      if (resolution?.payouts) {
        for (const p of resolution.payouts) {
          yieldByUser.set(p.userId, (yieldByUser.get(p.userId) ?? 0) + p.amount);
        }
      }
    }

    // 2. Fetch elimination logs to compute arenasWon and survivalStreak
    const eliminations = await this.prisma.eliminationLog.findMany({
      select: {
        userId: true,
        round: { select: { arenaId: true } },
      },
    });

    const eliminatedArenasByUser = new Map<string, Set<string>>();
    const eliminationCountByUser = new Map<string, number>();

    for (const el of eliminations) {
      if (!arenasByUser.has(el.userId)) arenasByUser.set(el.userId, new Set());
      arenasByUser.get(el.userId)!.add(el.round.arenaId);

      if (!eliminatedArenasByUser.has(el.userId)) {
        eliminatedArenasByUser.set(el.userId, new Set());
      }
      eliminatedArenasByUser.get(el.userId)!.add(el.round.arenaId);

      eliminationCountByUser.set(
        el.userId,
        (eliminationCountByUser.get(el.userId) ?? 0) + 1,
      );
    }

    // 3. Merge all user IDs
    const allUserIds = new Set([
      ...yieldByUser.keys(),
      ...arenasByUser.keys(),
    ]);

    if (allUserIds.size === 0) return [];

    // 4. Fetch user identity from PostgreSQL (same DB as game data)
    type UserRow = { id: string; walletAddress: string };
    const users: UserRow[] = await this.prisma.user.findMany({
      where: { id: { in: Array.from(allUserIds) } },
      select: { id: true, walletAddress: true },
    });

    const userMap = new Map<string, UserRow>(users.map((u) => [u.id, u]));

    // 5. Build unsorted player list
    const players: Omit<PlayerStats, "rank">[] = [];

    for (const userId of allUserIds) {
      const user = userMap.get(userId);
      if (!user) continue; // skip orphaned game records

      const participatedArenas = arenasByUser.get(userId) ?? new Set<string>();
      const eliminatedArenas = eliminatedArenasByUser.get(userId) ?? new Set<string>();

      const arenasWon = [...participatedArenas].filter(
        (a) => !eliminatedArenas.has(a),
      ).length;

      const roundsParticipated = roundsParticipatedByUser.get(userId) ?? 0;
      const eliminationCount = eliminationCountByUser.get(userId) ?? 0;
      const survivalStreak = Math.max(0, roundsParticipated - eliminationCount);

      players.push({
        id: user.id,
        walletAddress: user.walletAddress,
        totalYield: yieldByUser.get(userId) ?? 0,
        arenasWon,
        survivalStreak,
      });
    }

    // 6. Sort by totalYield descending, arenasWon as tiebreaker
    players.sort((a, b) => {
      const yieldDiff = b.totalYield - a.totalYield;
      if (yieldDiff !== 0) return yieldDiff;
      return b.arenasWon - a.arenasWon;
    });

    // 7. Assign 1-based ranks
    return players.map((p, i) => ({ ...p, rank: i + 1 }));
  }

  // ── Cursor encoding ───────────────────────────────────────────────

  private encodeCursor(offset: number): string {
    const payload: DecodedCursor = { offset };
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
  }

  private decodeCursor(cursor: string): number {
    try {
      const payload = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf-8"),
      ) as DecodedCursor;

      if (typeof payload.offset !== "number" || payload.offset < 0) {
        return 0;
      }
      return payload.offset;
    } catch {
      return 0;
    }
  }
}
