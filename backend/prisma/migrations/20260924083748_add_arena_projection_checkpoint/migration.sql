-- CreateTable
CREATE TABLE "arena_projection_checkpoints" (
    "id" TEXT NOT NULL,
    "arena_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "last_ledger_sequence" INTEGER NOT NULL,
    "projection_state" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "last_error" TEXT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "arena_projection_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "arena_projection_checkpoints_status_idx" ON "arena_projection_checkpoints"("status");

-- CreateIndex
CREATE UNIQUE INDEX "arena_projection_checkpoints_arena_id_network_key" ON "arena_projection_checkpoints"("arena_id", "network");
