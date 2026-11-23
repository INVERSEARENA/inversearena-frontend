/**
 * Profile summary service (#1501).
 *
 * Single source of truth for the wallet-scoped profile read used by both
 * `GET /api/users/me` and the dashboard bootstrap composer. Extracting the
 * Mongo identity lookup and the Postgres stats CTE here means the two
 * endpoints cannot drift: the bootstrap section and the source endpoint run
 * the exact same query.
 */

import type { PrismaClient } from "@prisma/client";
import { UserModel } from "../db/models/user.model";

export interface ProfileSummary {
  id: string;
  walletAddress: string;
  displayName: string | null;
  joinedAt: Date;
  lastLoginAt: Date | null;
  gamesPlayed: number;
  gamesWon: number;
  totalYieldEarned: string;
  currentRank: number | null;
}

export class ProfileNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "ProfileNotFoundError";
  }
}

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
 * Only the target user's row is returned — the rest of the platform's data
 * never leaves Postgres.
 */
async function aggregateStats(prisma: PrismaClient, userId: string) {
  type RawRow = {
    gamesPlayed: string; // bigint → string
    gamesWon: string; // bigint → string
    totalYield: string; // numeric → string
    rank: string | null; // bigint → string, null when unranked
  };

  const rows = await prisma.$queryRaw<RawRow[]>`
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
      SELECT rc.user_id, COUNT(*)::bigint AS arenas_won
      FROM (SELECT DISTINCT user_id, arena_id FROM round_choices) rc
      WHERE NOT EXISTS (
        SELECT 1
        FROM elimination_logs el
        JOIN rounds r ON r.id = el.round_id
        WHERE el.user_id = rc.user_id
          AND el.arena_id = rc.arena_id
          AND r.state = 'RESOLVED'
      )
      GROUP BY rc.user_id
    ),
      played AS (
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

/** Identity (MongoDB) + game stats (PostgreSQL) for one wallet-scoped user. */
export async function getUserProfileSummary(
  prisma: PrismaClient,
  userId: string,
): Promise<ProfileSummary> {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw new ProfileNotFoundError();

  const stats = await aggregateStats(prisma, userId);

  return {
    id: user._id.toString(),
    walletAddress: user.walletAddress,
    displayName: user.displayName ?? null,
    joinedAt: user.joinedAt,
    lastLoginAt: user.lastLoginAt,
    ...stats,
  };
}

export interface PublicPlayerProfile {
  address: string;
  alias: string | null;
  level: number;
  joinedAt: string;
  stats: {
    gamesPlayed: number;
    gamesWon: number;
    totalYieldEarned: string;
    currentRank: number | null;
    winRate: number;
  };
  achievements: Array<{
    definitionId: string;
    title: string;
    description: string;
    tier: "bronze" | "silver" | "gold" | "platinum";
    unlockedAt: string;
  }>;
  recentSettledArenas: Array<{
    arenaId: string;
    name: string;
    settledAt: string;
    result: "won" | "eliminated" | "participant";
    payout?: string;
  }>;
  privacy: {
    hideHistory: boolean;
    hideFromSearch: boolean;
  };
  isUnknown?: boolean;
  isBanned?: boolean;
  redirect?: boolean;
  canonicalAlias?: string;
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/i;
const ALIAS_GRACE_PERIOD_DAYS = 30;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeLevel(gamesPlayed: number, gamesWon: number): number {
  return Math.max(1, Math.floor(Math.sqrt(gamesPlayed * 2 + gamesWon * 6)) + 1);
}

function computeAchievements(gamesPlayed: number, gamesWon: number, totalYield: number) {
  const achievements: PublicPlayerProfile["achievements"] = [];
  const now = new Date().toISOString();

  if (gamesWon >= 1) {
    achievements.push({
      definitionId: "first_win",
      title: "First Blood",
      description: "Win your first arena",
      tier: "bronze",
      unlockedAt: now,
    });
  }
  if (gamesPlayed >= 10) {
    achievements.push({
      definitionId: "joined_10",
      title: "Veteran",
      description: "Join 10 arenas",
      tier: "bronze",
      unlockedAt: now,
    });
  }
  if (gamesWon >= 3) {
    achievements.push({
      definitionId: "win_streak_3",
      title: "On Fire",
      description: "Win 3 arenas in a row",
      tier: "silver",
      unlockedAt: now,
    });
  }
  if (gamesPlayed >= 50) {
    achievements.push({
      definitionId: "joined_50",
      title: "Arena Legend",
      description: "Join 50 arenas",
      tier: "gold",
      unlockedAt: now,
    });
  }
  if (totalYield >= 1000) {
    achievements.push({
      definitionId: "big_pot_win",
      title: "High Roller",
      description: "Win an arena with a pot over 1,000",
      tier: "platinum",
      unlockedAt: now,
    });
  }

  return achievements;
}

export async function getPublicUserProfile(
  prisma: PrismaClient,
  aliasOrAddress: string,
): Promise<PublicPlayerProfile> {
  const query = aliasOrAddress.trim();
  const isAddress = STELLAR_ADDRESS_REGEX.test(query);

  let user: any = null;
  let redirectedFromOldAlias = false;
  let canonicalAlias: string | undefined = undefined;

  // 1. Try resolving as active alias
  user = await UserModel.findOne({
    "aliasHistory.alias": { $regex: new RegExp(`^${escapeRegex(query)}$`, "i") },
    "aliasHistory.retiredAt": null,
  }).lean();

  // 2. If not active alias, check if it was recently retired (alias change redirect)
  if (!user && !isAddress) {
    const graceCutoff = new Date(Date.now() - ALIAS_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const retiredMatch = await UserModel.findOne({
      "aliasHistory.alias": { $regex: new RegExp(`^${escapeRegex(query)}$`, "i") },
      "aliasHistory.retiredAt": { $gte: graceCutoff.toISOString() },
    }).lean();

    if (retiredMatch) {
      user = retiredMatch;
      redirectedFromOldAlias = true;
      const activeEntry = (retiredMatch.aliasHistory as any[])?.find((h) => h.retiredAt === null);
      canonicalAlias = activeEntry?.alias || retiredMatch.walletAddress;
    }
  }

  // 3. If not found by alias and query looks like wallet address, look up by walletAddress
  if (!user && isAddress) {
    user = await UserModel.findOne({ walletAddress: query }).lean();
  }

  // 4. Unknown address edge case: return on-chain-only default profile
  if (!user) {
    if (isAddress) {
      return {
        address: query,
        alias: null,
        level: 1,
        joinedAt: new Date().toISOString(),
        stats: {
          gamesPlayed: 0,
          gamesWon: 0,
          totalYieldEarned: "0.00",
          currentRank: null,
          winRate: 0,
        },
        achievements: [],
        recentSettledArenas: [],
        privacy: {
          hideHistory: false,
          hideFromSearch: false,
        },
        isUnknown: true,
      };
    }
    throw new ProfileNotFoundError();
  }

  // 5. Banned / moderated players edge case
  if (user.isBanned) {
    return {
      address: user.walletAddress,
      alias: user.displayName ?? null,
      level: 1,
      joinedAt: user.joinedAt ? new Date(user.joinedAt).toISOString() : new Date().toISOString(),
      stats: {
        gamesPlayed: 0,
        gamesWon: 0,
        totalYieldEarned: "0.00",
        currentRank: null,
        winRate: 0,
      },
      achievements: [],
      recentSettledArenas: [],
      privacy: {
        hideHistory: true,
        hideFromSearch: true,
      },
      isBanned: true,
    };
  }

  // 6. Aggregate platform stats
  const stats = await aggregateStats(prisma, user._id.toString());
  const gamesPlayed = stats.gamesPlayed || 0;
  const gamesWon = stats.gamesWon || 0;
  const totalYield = Number(stats.totalYieldEarned) || 0;
  const winRate = gamesPlayed > 0 ? Math.round((gamesWon / gamesPlayed) * 100) : 0;
  const level = computeLevel(gamesPlayed, gamesWon);
  const achievements = computeAchievements(gamesPlayed, gamesWon, totalYield);

  // 7. Privacy filtering: respect hideHistory and hideFromSearch
  const privacy = {
    hideHistory: Boolean(user.privacySettings?.hideHistory),
    hideFromSearch: Boolean(user.privacySettings?.hideFromSearch),
  };

  let recentSettledArenas: PublicPlayerProfile["recentSettledArenas"] = [];

  if (!privacy.hideHistory) {
    try {
      // Find recent settled rounds where user participated
      const settledArenas = await prisma.arena.findMany({
        where: {
          OR: [
            { status: "SETTLED" },
            { rounds: { some: { state: "SETTLED" } } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
        include: {
          rounds: {
            where: { state: "SETTLED" },
            take: 1,
          },
        },
      });

      recentSettledArenas = settledArenas.slice(0, 5).map((a) => {
        const meta = (a.metadata as Record<string, any>) || {};
        return {
          arenaId: a.id,
          name: meta.name || `Arena #${a.id.slice(0, 6)}`,
          settledAt: a.updatedAt.toISOString(),
          result: "participant",
        };
      });
    } catch {
      recentSettledArenas = [];
    }
  }

  const activeAlias = (user.aliasHistory as any[])?.find((h) => h.retiredAt === null)?.alias ?? user.displayName ?? null;

  return {
    address: user.walletAddress,
    alias: activeAlias,
    level,
    joinedAt: user.joinedAt ? new Date(user.joinedAt).toISOString() : new Date().toISOString(),
    stats: {
      gamesPlayed,
      gamesWon,
      totalYieldEarned: stats.totalYieldEarned,
      currentRank: stats.currentRank,
      winRate,
    },
    achievements,
    recentSettledArenas,
    privacy,
    ...(redirectedFromOldAlias ? { redirect: true, canonicalAlias } : {}),
  };
}

export async function getUserPrivacySettings(userId: string) {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw new ProfileNotFoundError();
  return {
    hideHistory: Boolean(user.privacySettings?.hideHistory),
    hideFromSearch: Boolean(user.privacySettings?.hideFromSearch),
  };
}

export async function updateUserPrivacySettings(
  userId: string,
  settings: { hideHistory?: boolean; hideFromSearch?: boolean },
) {
  const user = await UserModel.findById(userId);
  if (!user) throw new ProfileNotFoundError();

  const current = user.privacySettings || { hideHistory: false, hideFromSearch: false };
  if (settings.hideHistory !== undefined) current.hideHistory = settings.hideHistory;
  if (settings.hideFromSearch !== undefined) current.hideFromSearch = settings.hideFromSearch;

  user.privacySettings = current;
  await user.save();

  return {
    hideHistory: current.hideHistory,
    hideFromSearch: current.hideFromSearch,
  };
}
