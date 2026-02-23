export interface AuditLogEntry {
  adminId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  status: "success" | "failed";
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditLog extends AuditLogEntry {
  id: string;
  createdAt: Date;
}

export interface RequestTokenResult {
  token: string;
  expiresAt: Date;
}
