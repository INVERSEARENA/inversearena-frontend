import { Schema, model, type Document } from "mongoose";

export interface MaintenanceWindowDocument extends Document {
  scheduledBy: string;
  startLedgerSequence: number;
  endLedgerSequence: number | null;
  reason: string;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  createdAt: Date;
}

const MaintenanceWindowSchema = new Schema<MaintenanceWindowDocument>(
  {
    scheduledBy: { type: String, required: true },
    startLedgerSequence: { type: Number, required: true },
    endLedgerSequence: { type: Number, default: null },
    reason: { type: String, required: true },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

MaintenanceWindowSchema.index({ startLedgerSequence: 1 });

export const MaintenanceWindowModel = model<MaintenanceWindowDocument>(
  "MaintenanceWindow",
  MaintenanceWindowSchema
);
