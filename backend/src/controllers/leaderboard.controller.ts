import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { UserModel } from "../db/models/user.model";
import { z } from "zod";

// ── Query param validation ──────────────────────────────────────────
const LeaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// ── Internal types ──────────────────────────────────────────────────
interface PlayerStats {
  rank: number;
  walletAddress: string;
  displayName: string | null;
  totalYield: string;
  gamesPlayed: number;
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
   * Aggregates all users' stats from resolved rounds and returns a
   * sorted array of players ranked by total yield (descending).
   */
  private async buildRankedPlayers(): Promise<PlayerStats[]> {
    // 1. Fetch all resolved rounds in one query
    const resolvedRounds = await this.prisma.round.findMany({
      where: { state: "RESOLVED" },
      select: { arenaId: true, metadata: true },
    });

    // 2. Accumulate per-user stats from round metadata
    const yieldByUser = new Map<string, number>();
    const arenasPerUser = new Map<string, Set<string>>();

    for (const round of resolvedRounds) {
      const meta = round.metadata as Record<string, unknown> | null;
      if (!meta) continue;

      // Track participation via playerChoices
      const choices = meta.playerChoices as
        | Array<{ userId: string }>
        | undefined;
      if (choices) {
        for (const c of choices) {
          if (!arenasPerUser.has(c.userId)) {
            arenasPerUser.set(c.userId, new Set());
          }
          arenasPerUser.get(c.userId)!.add(round.arenaId);
        }
      }

      // Track yield from resolution payouts
      const resolution = meta.resolution as
        | { payouts?: Array<{ userId: string; amount: number }> }
        | undefined;
      if (resolution?.payouts) {
        for (const p of resolution.payouts) {
          yieldByUser.set(
            p.userId,
            (yieldByUser.get(p.userId) ?? 0) + p.amount,
          );
        }
      }
    }

    // 3. Also count participation from elimination logs
    const eliminations = await this.prisma.eliminationLog.findMany({
      select: {
        userId: true,
        round: { select: { arenaId: true } },
      },
    });

    for (const el of eliminations) {
      if (!arenasPerUser.has(el.userId)) {
        arenasPerUser.set(el.userId, new Set());
      }
      arenasPerUser.get(el.userId)!.add(el.round.arenaId);
    }

    // 4. Merge all user IDs that have any activity
    const allUserIds = new Set([
      ...yieldByUser.keys(),
      ...arenasPerUser.keys(),
    ]);

    if (allUserIds.size === 0) {
      return [];
    }

    // 5. Fetch user identity from MongoDB in bulk
    const users = await UserModel.find(
      { _id: { $in: Array.from(allUserIds) } },
      { walletAddress: 1, displayName: 1 },
    ).lean();

    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    // 6. Build unsorted player list
    const players: Omit<PlayerStats, "rank">[] = [];

    for (const userId of allUserIds) {
      const user = userMap.get(userId);
      if (!user) continue; // skip orphaned game records

      players.push({
        walletAddress: user.walletAddress,
        displayName: (user.displayName as string) ?? null,
        totalYield: (yieldByUser.get(userId) ?? 0).toFixed(2),
        gamesPlayed: arenasPerUser.get(userId)?.size ?? 0,
      });
    }

    // 7. Sort by totalYield descending, then by gamesPlayed descending for tiebreaker
    players.sort((a, b) => {
      const yieldDiff = parseFloat(b.totalYield) - parseFloat(a.totalYield);
      if (yieldDiff !== 0) return yieldDiff;
      return b.gamesPlayed - a.gamesPlayed;
    });

    // 8. Assign 1-based ranks
    return players.map((p, i) => ({
      ...p,
      rank: i + 1,
    }));
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
