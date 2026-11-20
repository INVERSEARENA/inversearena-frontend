import { Schema, model, type Document } from "mongoose";

/**
 * Scoped API Key model (#1737).
 *
 * Stores hashed API keys for third-party read access with per-key quotas.
 * The raw key is never stored — only its SHA-256 hash. A key prefix is
 * stored for display/lookup purposes (first 8 chars of the raw key).
 *
 * Fields:
 *   - keyHash      : SHA-256 hash of the raw key (unique)
 *   - keyPrefix    : First 8 chars for display (e.g. "ia_live_…")
 *   - owner        : Wallet address or user id of the key owner
 *   - ownerLabel   : Human-readable owner name (e.g. "Analytics Bot")
 *   - scopes       : Array of granted scopes (read-only: "read:*")
 *   - quotaRequests: Requests allowed per window
 *   - quotaWindowSeconds: Quota window duration
 *   - status       : active | revoked | rotated
 *   - rotatedFrom  : If this key is a rotation, the old key's hash
 *   - lastUsedAt   : Last time this key authenticated a request
 *   - usageCount   : Total authenticated requests (lifetime)
 *   - expiresAt    : Optional expiry; null = no expiry
 */

export interface ApiKeyDocument extends Document {
  keyHash: string;
  keyPrefix: string;
  owner: string;
  ownerLabel?: string;
  scopes: string[];
  quotaRequests: number;
  quotaWindowSeconds: number;
  status: "active" | "revoked" | "rotated";
  rotatedFrom?: string;
  lastUsedAt: Date | null;
  usageCount: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeySchema = new Schema<ApiKeyDocument>(
  {
    keyHash: { type: String, required: true, unique: true, index: true },
    keyPrefix: { type: String, required: true },
    owner: { type: String, required: true, index: true },
    ownerLabel: { type: String, default: undefined },
    scopes: { type: [String], required: true, default: ["read:*"] },
    quotaRequests: { type: Number, required: true, default: 100 },
    quotaWindowSeconds: { type: Number, required: true, default: 3600 },
    status: { type: String, enum: ["active", "revoked", "rotated"], required: true, default: "active" },
    rotatedFrom: { type: String, default: undefined },
    lastUsedAt: { type: Date, default: null },
    usageCount: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ApiKeySchema.index({ owner: 1, status: 1 });
ApiKeySchema.index({ keyPrefix: 1 });

export const ApiKeyModel = model<ApiKeyDocument>("ApiKey", ApiKeySchema);
