import { Schema, model, type Document } from "mongoose";

// ── Alias history entry (#1414) ──────────────────────────────────────────────

export interface AliasHistoryEntry {
  alias: string;
  setAt: string;       // ISO date string
  retiredAt: string | null; // ISO date string, null if currently active
}

// ── User document ─────────────────────────────────────────────────────────────

export interface UserDocument extends Document {
  walletAddress: string;
  displayName?: string;
  /** Rotation history of public aliases. Wallet address is never stored here. */
  aliasHistory: AliasHistoryEntry[];
  /**
   * Arena watchlist (#1402): Prisma arena ids (Postgres `arenas.id`) the
   * user has bookmarked. Stored as plain strings — this document has no
   * foreign-key relationship to Postgres, so a watched arena that is
   * later deleted upstream just becomes a dangling id, resolved (or
   * dropped) by the caller when reading arena details, not by this model.
   */
  watchedArenaIds: string[];
  joinedAt: Date;
  lastLoginAt: Date;
}

const AliasHistoryEntrySchema = new Schema<AliasHistoryEntry>(
  {
    alias:      { type: String, required: true },
    setAt:      { type: String, required: true },
    retiredAt:  { type: String, default: null },
  },
  { _id: false },
);

const UserSchema = new Schema<UserDocument>(
  {
    walletAddress: { type: String, required: true, unique: true },
    displayName:   { type: String, default: undefined },
    aliasHistory:  { type: [AliasHistoryEntrySchema], default: [] },
    watchedArenaIds: { type: [String], default: [] },
    joinedAt:      { type: Date, required: true },
    lastLoginAt:   { type: Date, required: true },
  },
  { timestamps: false },
);

// Sparse index on active alias for fast uniqueness checks (#1414).
// Only documents with at least one active alias entry are indexed.
UserSchema.index(
  { "aliasHistory.alias": 1 },
  { sparse: true, collation: { locale: "en", strength: 2 } },
);

export const UserModel = model<UserDocument>("User", UserSchema);
