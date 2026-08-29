import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { UserModel } from "../db/models/user.model";
import { apiError } from "../utils/apiError";

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
  me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id, walletAddress } = req.user!;

    // ── Identity (MongoDB) ──────────────────────────────────────────
    const user = await UserModel.findById(id).lean();
    if (!user) {
      next(apiError(404, "USER_NOT_FOUND", "User not found"));
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

  /**
   * Aggregates gamesPlayed, gamesWon, totalYieldEarned, and currentRank in a
   * single indexed SQL query, reusing the CTE pattern from
   * `LeaderboardController.buildRankedPlayers` (leaderboard.controller.ts)
   * instead of four independent unbounded `findMany({ state: "RESOLVED" })`
   * scans that pulled every resolved round's metadata into Node.js per call.
   *
   * Preserves the original per-field semantics exactly:
   *  - gamesPlayed — distinct arenas from playerChoices metadata UNION
   *                  distinct arenas from elimination_logs (a user eliminated
   *                  without a matching metadata entry still counts).
   *  - gamesWon    — distinct metadata-participation arenas with no matching
   *                  RESOLVED-round elimination (anti-join, not subtraction of
   *                  independently-scoped counts). Elimination-only arenas are
   *                  not eligible to be "won".
   *  - totalYieldEarned / currentRank — summed/ranked purely from resolution
   *                  payouts in playerChoices metadata, platform-wide.
   *
   * The CTE pipeline:
   *  1. round_choices  – unnests playerChoices JSONB arrays from RESOLVED
   *                      rounds platform-wide, joined to that round's payout
   *  2. participation  – per user: distinct arenas participated in (metadata), total yield
   *  3. won            – participation arenas with no RESOLVED-round elimination
   *  4. ranked         – every user with any yield, ranked by total yield DESC
   *                      via a window function, matching the original
   *                      platform-wide rank comparison
   *
   * Only the target user's row is returned — the rest of the platform's data
   * never leaves Postgres.
   */
  private async aggregateStats(userId: string) {
    type RawRow = {
      gamesPlayed: string; // bigint → string
      gamesWon: string; // bigint → string
      totalYield: string; // numeric → string
      rank: string | null; // bigint → string, null when unranked
    };

    const rows = await this.prisma.$queryRaw<RawRow[]>`
      WITH round_choices AS (
        SELECT
          r.arena_id,
          (choice->>'userId')                         AS user_id,
          COALESCE((
            SELECT SUM((p->>'amount')::numeric)
            FROM jsonb_array_elements(r.metadata->'resolution'->'payouts') AS p
            WHERE p->>'userId' = choice->>'userId'
          ), 0)                                        AS payout
        FROM rounds r
        CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'playerChoices') AS c(choice)
        WHERE r.state = 'RESOLVED'
      ),
      participation AS (
        SELECT
          user_id,
          SUM(payout) AS total_yield
        FROM round_choices
        GROUP BY user_id
      ),
      won AS (
        -- Anti-join: credit a win only when the user participated in a
        -- RESOLVED arena and has no RESOLVED-round elimination in that arena.
        -- Counting then subtracting independently-scoped sets undercounts
        -- when elimination rows exist for non-RESOLVED rounds (#1346).
        SELECT rc.user_id, COUNT(*)::bigint AS arenas_won
        FROM (SELECT DISTINCT user_id, arena_id FROM round_choices) rc
        WHERE NOT EXISTS (
          SELECT 1
          FROM elimination_logs el
          JOIN rounds r ON r.id = el.round_id
          WHERE el.user_id = rc.user_id
            AND r.arena_id = rc.arena_id
            AND r.state = 'RESOLVED'
        )
        GROUP BY rc.user_id
      ),
      played AS (
        -- Union of metadata-participation arenas and elimination-only arenas,
        -- matching the original countGamesPlayed's two independent checks.
        SELECT user_id, COUNT(DISTINCT arena_id) AS arenas_played
        FROM (
          SELECT user_id, arena_id FROM round_choices
          UNION
          SELECT el.user_id, r.arena_id FROM elimination_logs el JOIN rounds r ON r.id = el.round_id
        ) all_arenas
        GROUP BY user_id
      ),
      ranked AS (
        SELECT
          user_id,
          total_yield,
          RANK() OVER (ORDER BY total_yield DESC) AS rank
        FROM participation
        WHERE total_yield > 0
      )
      SELECT
        COALESCE(pl.arenas_played, 0)::bigint                                          AS "gamesPlayed",
        COALESCE(w.arenas_won, 0)::bigint                                              AS "gamesWon",
        COALESCE(p.total_yield, 0)::numeric                                            AS "totalYield",
        r.rank::bigint                                                                 AS "rank"
      FROM (SELECT ${userId}::text AS user_id) target
      LEFT JOIN played pl ON pl.user_id = target.user_id
      LEFT JOIN participation p ON p.user_id = target.user_id
      LEFT JOIN won w ON w.user_id = target.user_id
      LEFT JOIN ranked r ON r.user_id = target.user_id
    `;

    const row = rows[0];
    const totalYield = row ? Number(row.totalYield) : 0;

    return {
      gamesPlayed: row ? Number(row.gamesPlayed) : 0,
      gamesWon: row ? Number(row.gamesWon) : 0,
      totalYieldEarned: totalYield.toFixed(2),
      currentRank: row?.rank !== null && row?.rank !== undefined ? Number(row.rank) : null,
    };
  }
}
