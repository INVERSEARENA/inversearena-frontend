import { Schema, model, type Document } from "mongoose";

/**
 * One document per payout source account. `lastNonce` is the highest nonce
 * reserved for that source; reservation is an atomic $inc upsert so two
 * concurrent payout creations can never observe the same value.
 */
export interface PayoutNonceCounterDocument extends Document<string> {
  _id: string;
  lastNonce: number;
  createdAt: Date;
  updatedAt: Date;
}

const PayoutNonceCounterSchema = new Schema<PayoutNonceCounterDocument>(
  {
    _id: { type: String, required: true },
    lastNonce: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, _id: false }
);

export const PayoutNonceCounterModel = model<PayoutNonceCounterDocument>(
  "PayoutNonceCounter",
  PayoutNonceCounterSchema
);
