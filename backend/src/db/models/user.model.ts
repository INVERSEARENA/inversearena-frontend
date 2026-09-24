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
