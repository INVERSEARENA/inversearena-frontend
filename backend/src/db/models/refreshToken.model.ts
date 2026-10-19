import { Schema, model, type Document } from "mongoose";
import { randomUUID } from "crypto";

export interface RefreshTokenDocument extends Document {
  tokenHash: string;
  familyId: string;
  userId: string;
  used: boolean;
  revoked: boolean;
  expiresAt: Date;
  createdAt: Date;
  /**
   * JTIs of the access/refresh token pair minted alongside this row (#1410).
   * A row is the "current" state of its familyId (session) while
   * used=false — its jtis are exactly what a per-session revoke must remove
   * from Redis (SessionStore) without touching any other family's jtis.
   * Optional in the type (not on rows written before this field existed);
   * callers must tolerate a missing value on old rows.
   */
  accessJti?: string;
  refreshJti?: string;
  /** Best-effort device label / IP captured at login, carried forward across rotations. */
  deviceLabel?: string;
  ip?: string | null;
}

const RefreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    used: { type: Boolean, required: true, default: false },
    revoked: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, required: true },
    accessJti: { type: String },
    refreshJti: { type: String },
    deviceLabel: { type: String, default: "Unknown device" },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel = model<RefreshTokenDocument>(
  "RefreshToken",
  RefreshTokenSchema
);

export function generateFamilyId(): string {
  return randomUUID();
}
