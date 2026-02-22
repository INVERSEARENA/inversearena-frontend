import { Schema, model, type Document } from "mongoose";

export interface AuditLogDocument extends Document {
  adminId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  status: "success" | "failed";
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<AuditLogDocument>(
  {
    adminId: { type: String, required: true },
    action: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    status: { type: String, enum: ["success", "failed"], required: true },
    metadata: { type: Schema.Types.Mixed, default: undefined },
    errorMessage: { type: String, default: undefined },
    ipAddress: { type: String, default: undefined },
    userAgent: { type: String, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ adminId: 1, createdAt: -1 });
AuditLogSchema.index({ resourceType: 1, resourceId: 1 });

export const AuditLogModel = model<AuditLogDocument>("AuditLog", AuditLogSchema);
