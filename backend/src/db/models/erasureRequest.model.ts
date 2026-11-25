import { Schema, model, type Document } from "mongoose";

/**
 * Erasure Request model (#1739).
 *
 * Tracks the lifecycle of a right-to-erasure request:
 *   pending → in_progress → completed (or blocked)
 *
 * Includes an SLA clock: `requestedAt` starts the 30-day SLA, and
 * `completedAt` records when the erasure finished. Audit trail is
 * persisted via the existing AuditLogModel.
 */

export interface ErasureRequestDocument extends Document {
  userId: string;
  walletAddress: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  reason: "user_request" | "regulatory";
  requestedAt: Date;
  completedAt: Date | null;
  summary: string | null;
  blockedReason: string | null;
}

const ErasureRequestSchema = new Schema<ErasureRequestDocument>(
  {
    userId: { type: String, required: true, index: true },
    walletAddress: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "blocked", "cancelled"],
      required: true,
      default: "pending",
    },
    reason: {
      type: String,
      enum: ["user_request", "regulatory"],
      required: true,
      default: "user_request",
    },
    requestedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date, default: null },
    summary: { type: String, default: null },
    blockedReason: { type: String, default: null },
  },
  { timestamps: true },
);

ErasureRequestSchema.index({ status: 1, requestedAt: 1 });

export const ErasureRequestModel = model<ErasureRequestDocument>(
  "ErasureRequest",
  ErasureRequestSchema,
);
