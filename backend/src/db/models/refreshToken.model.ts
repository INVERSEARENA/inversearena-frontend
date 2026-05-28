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
}

const RefreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    used: { type: Boolean, required: true, default: false },
    revoked: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, required: true },
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
