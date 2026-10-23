CREATE TABLE "creator_templates" (
    "id" TEXT NOT NULL,
    "owner_address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "payload" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creator_templates_owner_address_name_key" ON "creator_templates"("owner_address", "name");
CREATE INDEX "creator_templates_owner_address_status_created_at_idx"
    ON "creator_templates"("owner_address", "status", "created_at" DESC);
