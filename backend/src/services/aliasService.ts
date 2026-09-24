/**
 * Alias Service (#1414)
 *
 * Design note
 * -----------
 * Ownership   : Single point of enforcement for alias uniqueness, profanity
 *               filtering, rotation history, and public-profile resolution.
 *
 * State model : An alias is ACTIVE while owned by a user.  When a user sets a
 *               new alias the previous one transitions to RETIRED in the history
 *               table.  Retired aliases cannot be claimed by others for
 *               ALIAS_GRACE_PERIOD_DAYS to prevent impersonation.
 *
 * Privacy     : Wallet addresses are NEVER returned in public-profile responses.
 *               Historical game results remain attributable via the alias slug,
 *               not the wallet.
 *
 * Profanity   : A minimal built-in block-list is shipped.  Operators may extend
 *               it via the ALIAS_BLOCK_LIST env variable (comma-separated).
 *
 * Compatibility: No existing REST surface changes.  The `displayName` field on
 *               the users.me response continues to work; aliases are the new
 *               canonical source and are back-filled to displayName on set.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { aliasUpdateTotal } from "../utils/metrics";
import { UserModel } from "../db/models/user.model";
import { apiError } from "../utils/apiError";

// ── Config ───────────────────────────────────────────────────────────────────

const ALIAS_GRACE_PERIOD_DAYS = 30;
const ALIAS_HISTORY_MAX = 50; // cap stored history per user

/** Minimal built-in block-list — extend via env. */
const BUILT_IN_BLOCK_LIST = [
  "admin",
  "administrator",
  "moderator",
  "support",
  "inversearena",
  "inverse",
  "system",
  "null",
  "undefined",
  "root",
  "test",
  "fuck",
  "shit",
  "ass",
  "bitch",
  "cunt",
  "nigger",
  "nigga",
  "faggot",
];

function buildBlockList(): Set<string> {
  const extra = (process.env.ALIAS_BLOCK_LIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILT_IN_BLOCK_LIST, ...extra]);
}

const BLOCK_LIST = buildBlockList();

function isProfane(alias: string): boolean {
  const lower = alias.toLowerCase();
  for (const word of BLOCK_LIST) {
    if (lower.includes(word)) return true;
  }
  return false;
}

// ── In-memory alias store (backed by MongoDB user model + PG for attribution)
// In a full production deployment this would be its own collection / table.
// We store alias history in a lightweight JSON column on the Mongo document to
// avoid a migration, then expose it via typed accessors. ─────────────────────

export interface AliasHistoryEntry {
  alias: string;
  setAt: string; // ISO string
  retiredAt: string | null; // ISO string, null if still active
}

export interface PublicAliasProfile {
  alias: string;
  /** Internal opaque user id — never a wallet address. */
  userId: string;
  createdAt: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class AliasService {
  // prisma is injected for future PG integration; currently history lives in Mongo.
  constructor(private readonly _prisma: PrismaClient) {}

  /**
   * Set (or rotate) the alias for a user.
   * Throws an API error (409) if the alias is already taken or profane.
   */
  async setAlias(
    userId: string,
    alias: string,
  ): Promise<{ alias: string; history: AliasHistoryEntry[] }> {
    // 1. Profanity check
    if (isProfane(alias)) {
      aliasUpdateTotal.inc({ result: "profanity_blocked" });
      throw apiError(422, "ALIAS_PROFANE", "Alias contains prohibited content");
    }

    // 2. Uniqueness check (case-insensitive)
    const existing = await UserModel.findOne({
      "aliasHistory.alias": { $regex: new RegExp(`^${escapeRegex(alias)}$`, "i") },
      "aliasHistory.retiredAt": null,
    }).lean();

    if (existing && existing._id.toString() !== userId) {
      aliasUpdateTotal.inc({ result: "conflict" });
      throw apiError(409, "ALIAS_TAKEN", `Alias '${alias}' is already in use`);
    }

    // Also block aliases retired within the grace period
    const graceCutoff = new Date(
      Date.now() - ALIAS_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );
    const recentlyRetired = await UserModel.findOne({
      "aliasHistory.alias": { $regex: new RegExp(`^${escapeRegex(alias)}$`, "i") },
      "aliasHistory.retiredAt": { $gte: graceCutoff.toISOString() },
      _id: { $ne: userId },
    }).lean();

    if (recentlyRetired) {
      aliasUpdateTotal.inc({ result: "grace_period_blocked" });
      throw apiError(
        409,
        "ALIAS_RECENTLY_RETIRED",
        `Alias '${alias}' was recently used by another player and is temporarily unavailable`,
      );
    }

    // 3. Retire current active alias (if any)
    const now = new Date().toISOString();
    const user = await UserModel.findById(userId);
    if (!user) {
      throw apiError(404, "USER_NOT_FOUND", "User not found");
    }

    const history: AliasHistoryEntry[] = (user as any).aliasHistory ?? [];

    // Mark the current active alias as retired
    const updatedHistory = history.map((entry) =>
      entry.retiredAt === null ? { ...entry, retiredAt: now } : entry,
    );

    // Append new entry
    updatedHistory.push({ alias, setAt: now, retiredAt: null });

    // Cap history to avoid unbounded growth
    const trimmed = updatedHistory.slice(-ALIAS_HISTORY_MAX);

    // 4. Persist
    await UserModel.findByIdAndUpdate(userId, {
      displayName: alias,
      aliasHistory: trimmed,
    });

    logger.info({ userId, alias }, "alias_updated");
    aliasUpdateTotal.inc({ result: "success" });

    return { alias, history: trimmed };
  }

  /**
   * Returns the full alias rotation history for the calling user (newest first).
   */
  async getAliasHistory(userId: string): Promise<AliasHistoryEntry[]> {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw apiError(404, "USER_NOT_FOUND", "User not found");

    const history: AliasHistoryEntry[] = ((user as any).aliasHistory ?? []).slice().reverse();
    return history;
  }

  /**
   * Resolves an alias to its anonymised public profile.
   * Returns `null` if the alias is not active.
   */
  async resolvePublicProfile(alias: string): Promise<PublicAliasProfile | null> {
    const user = await UserModel.findOne({
      "aliasHistory.alias": { $regex: new RegExp(`^${escapeRegex(alias)}$`, "i") },
      "aliasHistory.retiredAt": null,
    }).lean();

    if (!user) return null;

    const entry = ((user as any).aliasHistory as AliasHistoryEntry[])
      .find(
        (h) =>
          h.alias.toLowerCase() === alias.toLowerCase() && h.retiredAt === null,
      );

    return {
      alias: entry?.alias ?? alias,
      userId: user._id.toString(),
      createdAt: entry?.setAt ?? (user as any).joinedAt?.toISOString() ?? new Date().toISOString(),
    };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
