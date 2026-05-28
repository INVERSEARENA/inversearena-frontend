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
   * Aggregates per-user stats using a single PostgreSQL CTE, avoiding the
   * O(rounds × players) memory spike of loading all round rows into Node.js.
   *
   * The CTE pipeline:
   *  1. round_choices  – unnests playerChoices JSONB arrays from RESOLVED rounds
   *  2. round_stats    – groups by userId: totalYield, roundsParticipated, arenas
   *  3. elim_stats     – groups elimination_logs by userId
   *  4. all_users      – UNION of both sets so eliminated-only players are included
   *
   * Result is pre-sorted by totalYield DESC, arenasWon DESC so JS only assigns ranks.
   */
  private async buildRankedPlayers(): Promise<PlayerStats[]> {
    type RawRow = {
      id: string;
      walletAddress: string;
      totalYield: string;      // PostgreSQL numeric → string in Prisma $queryRaw
      arenasWon: string;       // bigint → string
      survivalStreak: string;  // bigint → string
    };

    const rows = await this.prisma.$queryRaw<RawRow[]>`
      WITH round_choices AS (
        SELECT
          r.id                                       AS round_id,
          r.arena_id,
          (choice->>'userId')                        AS user_id,
          COALESCE((
            SELECT SUM((p->>'amount')::numeric)
            FROM jsonb_array_elements(r.metadata->'resolution'->'payouts') AS p
            WHERE p->>'userId' = choice->>'userId'
          ), 0)                                      AS payout
        FROM rounds r
        CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'playerChoices') AS c(choice)
        WHERE r.state = 'RESOLVED'
      ),
      round_stats AS (
        SELECT
          user_id,
          SUM(payout)                   AS total_yield,
          COUNT(*)                      AS rounds_participated,
          COUNT(DISTINCT arena_id)      AS arenas_participated
        FROM round_choices
        GROUP BY user_id
      ),
      elim_stats AS (
        SELECT
          el.user_id,
          COUNT(DISTINCT r.arena_id)    AS arenas_eliminated,
          COUNT(*)                      AS eliminations
        FROM elimination_logs el
        JOIN rounds r ON r.id = el.round_id
        GROUP BY el.user_id
      ),
      all_user_ids AS (
        SELECT user_id FROM round_stats
        UNION
        SELECT user_id FROM elim_stats
      )
      SELECT
        u.id,
        u.wallet_address                                                    AS "walletAddress",
        COALESCE(rs.total_yield, 0)::numeric                                AS "totalYield",
        GREATEST(0,
          COALESCE(rs.arenas_participated, 0)::bigint
          - COALESCE(es.arenas_eliminated, 0)::bigint
        )                                                                   AS "arenasWon",
        GREATEST(0,
          COALESCE(rs.rounds_participated, 0)::bigint
          - COALESCE(es.eliminations, 0)::bigint
        )                                                                   AS "survivalStreak"
      FROM all_user_ids au
      JOIN users u ON u.id = au.user_id
      LEFT JOIN round_stats rs ON rs.user_id = au.user_id
      LEFT JOIN elim_stats es ON es.user_id = au.user_id
      ORDER BY "totalYield" DESC, "arenasWon" DESC
    `;

    if (rows.length === 0) return [];

    return rows.map((row, i) => ({
      id: row.id,
      walletAddress: row.walletAddress,
      totalYield: Number(row.totalYield),
      arenasWon: Number(row.arenasWon),
      survivalStreak: Number(row.survivalStreak),
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
