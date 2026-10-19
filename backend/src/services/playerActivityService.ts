/**
 * Player Activity Feed Service (#1403)
 *
 * Cursor-paginated feed of a player's elimination events, keyed by wallet
 * address (the identifier actually stored on `elimination_logs.user_id` —
 * see the design note below).
 *
 * ## Design note: ownership, state, failure behavior, compatibility
 *
 * - **Ownership**: one wallet's elimination history. The cursor is scoped
 *   per wallet; there is no cross-wallet pagination state to leak.
 * - **State transitions**: an elimination row is written exactly once, by
 *   `RoundRepository.recordResolution`, when a round resolves. Rows are
 *   never updated or deleted, so a given page's contents are stable once
 *   fetched — a later poll only ever sees the same rows plus any newer ones.
 * - **Failure behavior**: an invalid/garbled cursor decodes to "start from
 *   the most recent event" (fail open, matching the rest of this codebase's
 *   cursor handling in roundRepository/arenas/pools) rather than throwing —
 *   a stale bookmark should degrade to a fresh page, not break the feed.
 * - **Compatibility**: purely additive — a new GET endpoint and no schema
 *   changes. `Round`/`EliminationLog` are read-only from this service.
 *
 * ## Why keyset pagination, not the codebase's existing offset cursor
 *
 * Every other paginated endpoint in this backend (arenas.ts, pools.ts,
 * roundRepository.listByArenaId) encodes a plain numeric offset into its
 * cursor. That has a real gap/duplicate bug under concurrent writes: if a
 * new elimination is inserted with a rank ahead of an in-flight cursor's
 * position between two page requests, `skip: offset` on the next page
 * either re-shows an item the caller already saw (the new row displaced an
 * already-seen row past the boundary) or skips one entirely (the reverse
 * shift). For a live activity feed — the exact case #1403 calls out
 * ("pagination has no gaps when new ledger events arrive between
 * requests") — that's the wrong tool.
 *
 * Keyset pagination instead encodes the last-seen row's own sort key
 * (eliminatedAt, id) and filters strictly past it on the next page. Newly
 * inserted rows can only land after the cursor in sort order (this feed is
 * newest-first, so "after" means older) or before it; either way, every
 * row the caller has already seen keeps its position relative to the
 * cursor, so no already-returned row is ever skipped or repeated.
 */
import type { PrismaClient } from "@prisma/client";

export interface PlayerActivityEvent {
  id: string;
  type: "player_eliminated";
  timestamp: string;
  arenaId: string;
  roundNumber: number;
  reason: string | null;
}

export interface PlayerActivityPage {
  walletAddress: string;
  items: PlayerActivityEvent[];
  cursor: string | null;
  hasMore: boolean;
}

interface ActivityCursor {
  eliminatedAt: string;
  id: string;
}

export class PlayerActivityService {
  constructor(private readonly prisma: PrismaClient) {}

  async getActivityFeed(
    walletAddress: string,
    limit: number,
    cursor?: string,
  ): Promise<PlayerActivityPage> {
    const decoded = cursor ? decodeCursor(cursor) : null;

    const rows = await this.prisma.eliminationLog.findMany({
      where: {
        userId: walletAddress,
        ...(decoded
          ? {
              OR: [
                { eliminatedAt: { lt: new Date(decoded.eliminatedAt) } },
                {
                  eliminatedAt: new Date(decoded.eliminatedAt),
                  id: { lt: decoded.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ eliminatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        round: { select: { arenaId: true, roundNumber: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const items: PlayerActivityEvent[] = page.map((row) => ({
      id: row.id,
      type: "player_eliminated",
      timestamp: row.eliminatedAt.toISOString(),
      arenaId: row.round.arenaId,
      roundNumber: row.round.roundNumber,
      reason: row.reason,
    }));

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ eliminatedAt: last.eliminatedAt.toISOString(), id: last.id })
        : null;

    return {
      walletAddress,
      items,
      cursor: nextCursor,
      hasMore,
    };
  }
}

function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string): ActivityCursor | null {
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as Partial<ActivityCursor>;
    if (typeof payload.eliminatedAt !== "string" || typeof payload.id !== "string") {
      return null;
    }
    if (Number.isNaN(Date.parse(payload.eliminatedAt))) return null;
    return { eliminatedAt: payload.eliminatedAt, id: payload.id };
  } catch {
    return null;
  }
}
