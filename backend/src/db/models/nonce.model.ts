import { Schema, model, type Document } from "mongoose";

export interface NonceDocument extends Document {
  walletAddress: string;
  nonce: string;
  used: boolean;
  expiresAt: Date;
  createdAt: Date;
}

const NonceSchema = new Schema<NonceDocument>(
  {
    walletAddress: { type: String, required: true, index: true },
    nonce: { type: String, required: true },
    used: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

NonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const NonceModel = model<NonceDocument>("Nonce", NonceSchema);
