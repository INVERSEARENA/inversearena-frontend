import { Schema, model, type Document } from "mongoose";
import type { PaymentStatus, TransactionRecord } from "../../types/payment";

export interface TransactionDocument extends Omit<TransactionRecord, "id">, Document {
  _id: string;
}

const TransactionSchema = new Schema<TransactionDocument>(
  {
    _id: { type: String, required: true },
    payoutId: { type: String, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    sourceAccount: { type: String, required: true },
    destinationAccount: { type: String, required: true },
    asset: { type: String, enum: ["XLM", "USDC"], required: true },
    amountStroops: { type: String, required: true },
    nonce: { type: Number, required: true },
    status: {
      type: String,
      enum: ["built", "queued", "awaiting_signature", "submitted", "confirmed", "failed"] satisfies PaymentStatus[],
      required: true,
    },
    unsignedXdr: { type: String, required: true },
    signedXdr: { type: String, default: null },
    txHash: { type: String, default: null },
    errorMessage: { type: String, default: null },
    attempts: { type: Number, required: true, default: 0 },
    confirmedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

TransactionSchema.index({ sourceAccount: 1, nonce: -1 });
TransactionSchema.index({ status: 1 });
TransactionSchema.index({ txHash: 1 });

export const TransactionModel = model<TransactionDocument>("Transaction", TransactionSchema);
