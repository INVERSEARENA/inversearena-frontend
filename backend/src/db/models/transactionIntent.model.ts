import { Schema, model, type Document } from "mongoose";
import type { IntentKind, IntentStatus, TransactionIntentRecord } from "../../types/transactionIntent";

export interface TransactionIntentDocument extends Omit<TransactionIntentRecord, "id"> {
  _id: string;
}

const TransactionIntentSchema = new Schema<TransactionIntentDocument>(
  {
    _id: { type: String, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    kind: {
      type: String,
      enum: [
        "create_pool",
        "stake",
        "unstake",
        "join_arena",
        "commit_choice",
        "reveal_choice",
        "claim",
      ] satisfies IntentKind[],
      required: true,
    },
    ownerWallet: { type: String, required: true },
    status: {
      type: String,
      enum: [
        "built",
        "awaiting_signature",
        "submitted",
        "confirmed",
        "failed",
        "expired",
      ] satisfies IntentStatus[],
      required: true,
    },
    unsignedXdr: { type: String, required: true },
    signedXdr: { type: String, default: null },
    txHash: { type: String, default: null },
    errorMessage: { type: String, default: null },
    attempts: { type: Number, required: true, default: 0 },
    signAttempts: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
    confirmedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

TransactionIntentSchema.index({ ownerWallet: 1, status: 1 });
TransactionIntentSchema.index({ expiresAt: 1 });

export const TransactionIntentModel = model<TransactionIntentDocument>(
  "TransactionIntent",
  TransactionIntentSchema
);
