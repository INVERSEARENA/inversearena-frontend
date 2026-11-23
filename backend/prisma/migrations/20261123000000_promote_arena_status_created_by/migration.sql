-- Promote arena status and creator from JSON metadata to indexed columns (#1765)

ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "created_by" TEXT;

UPDATE "arenas"
SET
  "status" = COALESCE(NULLIF("metadata"->>'status', ''), 'ACTIVE'),
  "created_by" = NULLIF("metadata"->>'createdBy', '')
WHERE "metadata" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "arenas_status_idx" ON "arenas"("status");
CREATE INDEX IF NOT EXISTS "arenas_created_by_idx" ON "arenas"("created_by");
CREATE INDEX IF NOT EXISTS "arenas_status_created_at_id_idx" ON "arenas"("status", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "arenas_created_by_created_at_id_idx" ON "arenas"("created_by", "created_at" DESC, "id" DESC);
