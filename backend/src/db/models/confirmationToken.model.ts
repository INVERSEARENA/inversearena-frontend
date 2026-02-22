import { Schema, model, type Document } from "mongoose";

export interface ConfirmationTokenDocument extends Document {
  adminId: string;
  tokenHash: string;
  action: string;
  resourceId: string;
  used: boolean;
  expiresAt: Date;
  createdAt: Date;
}

const ConfirmationTokenSchema = new Schema<ConfirmationTokenDocument>(
  {
    adminId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    action: { type: String, required: true },
    resourceId: { type: String, required: true },
    used: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ConfirmationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ConfirmationTokenModel = model<ConfirmationTokenDocument>(
  "ConfirmationToken",
  ConfirmationTokenSchema
);
