-- CreateTable
-- Append-only audit log for all admin actions.
-- Rows in this table must never be deleted.
CREATE TABLE "audit_logs" (
    "id"          TEXT NOT NULL,
    "admin_id"    TEXT NOT NULL,
    "action"      TEXT NOT NULL,
    "resource_id" TEXT,
    "metadata"    JSONB,
    "ip_address"  TEXT NOT NULL,
    "user_agent"  TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_idx" ON "audit_logs"("admin_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
