export type AuditActor = { type: "admin" | "system" | "anonymous"; id: string };
export type AuditResource = { type: string; id: string };

export interface AuditLogEntry {
  adminId: string;
  actor?: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string;
  resource?: AuditResource;
  correlationId?: string;
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
