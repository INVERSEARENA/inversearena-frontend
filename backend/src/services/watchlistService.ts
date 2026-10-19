/**
 * Arena Watchlist Service (#1402)
 *
 * Design note
 * -----------
 * Ownership    : Single point of enforcement for watch/unwatch idempotency
 *                and arena-id validation. UserModel.watchedArenaIds
 *                (Mongoose) is the persisted state; this service never
 *                writes to it directly from a route handler.
 *
 * State model  : A set (deduplicated array) of Prisma arena ids per user.
 *                Watch/unwatch are both idempotent: watching an
 *                already-watched arena, or unwatching an already-absent
 *                one, succeeds and returns the current list unchanged
 *                rather than erroring.
 *
 * Compatibility: New field, new endpoints. No existing REST surface
 *                changes.
 */

import type { PrismaClient } from "@prisma/client";
import { UserModel } from "../db/models/user.model";
import { apiError } from "../utils/apiError";
import { logger } from "../utils/logger";
import { watchlistOperationsTotal } from "../utils/metrics";

const MAX_WATCHED_ARENAS = 200;

export class WatchlistService {
  constructor(private readonly prisma: PrismaClient) {}

  private async assertArenaExists(arenaId: string): Promise<void> {
    const arena = await this.prisma.arena.findUnique({ where: { id: arenaId }, select: { id: true } });
    if (!arena) {
      throw apiError(404, "ARENA_NOT_FOUND", `Arena '${arenaId}' not found`);
    }
  }

  /**
   * Adds `arenaId` to the user's watchlist. Idempotent: already-watched
   * returns the current list unchanged rather than erroring or
   * duplicating the entry.
   */
  async watch(userId: string, arenaId: string): Promise<string[]> {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw apiError(404, "USER_NOT_FOUND", "User not found");

    const current: string[] = (user as { watchedArenaIds?: string[] }).watchedArenaIds ?? [];
    if (current.includes(arenaId)) {
      watchlistOperationsTotal.inc({ operation: "watch", result: "noop" });
      return current;
    }

    await this.assertArenaExists(arenaId);

    if (current.length >= MAX_WATCHED_ARENAS) {
      watchlistOperationsTotal.inc({ operation: "watch", result: "limit_exceeded" });
      throw apiError(409, "WATCHLIST_LIMIT_EXCEEDED", `A watchlist can hold at most ${MAX_WATCHED_ARENAS} arenas`);
    }

    const updated = await UserModel.findByIdAndUpdate(
      userId,
      { $addToSet: { watchedArenaIds: arenaId } },
      { new: true },
    ).lean();

    watchlistOperationsTotal.inc({ operation: "watch", result: "added" });
    logger.info({ userId, arenaId }, "arena_watched");

    return (updated as { watchedArenaIds?: string[] } | null)?.watchedArenaIds ?? [...current, arenaId];
  }

  /**
   * Removes `arenaId` from the user's watchlist. Idempotent: an arena
   * that was never watched (or already unwatched) returns the current
   * list unchanged rather than erroring.
   */
  async unwatch(userId: string, arenaId: string): Promise<string[]> {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw apiError(404, "USER_NOT_FOUND", "User not found");

    const current: string[] = (user as { watchedArenaIds?: string[] }).watchedArenaIds ?? [];
    if (!current.includes(arenaId)) {
      watchlistOperationsTotal.inc({ operation: "unwatch", result: "noop" });
      return current;
    }

    const updated = await UserModel.findByIdAndUpdate(
      userId,
      { $pull: { watchedArenaIds: arenaId } },
      { new: true },
    ).lean();

    watchlistOperationsTotal.inc({ operation: "unwatch", result: "removed" });
    logger.info({ userId, arenaId }, "arena_unwatched");

    return (updated as { watchedArenaIds?: string[] } | null)?.watchedArenaIds ?? current.filter((id) => id !== arenaId);
  }

  /** Returns the user's watchlist, oldest-first (insertion order). */
  async list(userId: string): Promise<string[]> {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw apiError(404, "USER_NOT_FOUND", "User not found");
    return (user as { watchedArenaIds?: string[] }).watchedArenaIds ?? [];
  }
}
