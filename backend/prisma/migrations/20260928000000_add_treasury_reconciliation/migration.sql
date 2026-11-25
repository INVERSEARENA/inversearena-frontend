-- CreateTable
CREATE TABLE "treasury_fee_records" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "record_type" TEXT NOT NULL DEFAULT 'platform_fee',
    "arena_id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "source_tx_hash" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "source_ledger_sequence" INTEGER NOT NULL,
    "source_ledger_closed_at" TIMESTAMP(3) NOT NULL,
    "expected_amount_atomic" BIGINT NOT NULL,
    "config_version" INTEGER NOT NULL,
    "fee_bps_applied" INTEGER NOT NULL,
    "destination" TEXT,
    "actual_amount_atomic" BIGINT,
    "actual_tx_hash" TEXT,
    "actual_destination" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "discrepancy_type" TEXT,
    "reconciled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_fee_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treasury_fee_records_arena_id_idx" ON "treasury_fee_records"("arena_id");

-- CreateIndex
CREATE INDEX "treasury_fee_records_status_idx" ON "treasury_fee_records"("status");

-- CreateIndex
CREATE INDEX "treasury_fee_records_source_ledger_sequence_idx" ON "treasury_fee_records"("source_ledger_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_fee_records_network_source_tx_hash_source_event_i_key" ON "treasury_fee_records"("network", "source_tx_hash", "source_event_id");

-- CreateTable
CREATE TABLE "treasury_reconciliation_checkpoints" (
    "id" TEXT NOT NULL,
    "arena_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "last_ledger_sequence" INTEGER NOT NULL,
    "last_known_fee_bps" INTEGER NOT NULL DEFAULT 1000,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "last_error" TEXT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_reconciliation_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treasury_reconciliation_checkpoints_status_idx" ON "treasury_reconciliation_checkpoints"("status");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_reconciliation_checkpoints_arena_id_network_key" ON "treasury_reconciliation_checkpoints"("arena_id", "network");
