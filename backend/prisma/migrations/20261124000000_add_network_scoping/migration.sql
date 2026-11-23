-- Issue #1841: scope chain-dependent records by Stellar network.
-- Backfill defaults to testnet passphrase for existing rows.

ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "network" TEXT NOT NULL DEFAULT 'Test SDF Network ; September 2015';
ALTER TABLE "pools" ADD COLUMN IF NOT EXISTS "network" TEXT NOT NULL DEFAULT 'Test SDF Network ; September 2015';
ALTER TABLE "rounds" ADD COLUMN IF NOT EXISTS "network" TEXT NOT NULL DEFAULT 'Test SDF Network ; September 2015';
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "network" TEXT NOT NULL DEFAULT 'Test SDF Network ; September 2015';
ALTER TABLE "elimination_logs" ADD COLUMN IF NOT EXISTS "network" TEXT NOT NULL DEFAULT 'Test SDF Network ; September 2015';

-- Replace old uniqueness/indexes with network-scoped equivalents.
DROP INDEX IF EXISTS "rounds_arena_id_round_number_key";
CREATE UNIQUE INDEX IF NOT EXISTS "rounds_network_arena_id_round_number_key" ON "rounds"("network", "arena_id", "round_number");

DROP INDEX IF EXISTS "transactions_tx_hash_created_at_key";
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_network_tx_hash_created_at_key" ON "transactions"("network", "tx_hash", "created_at");

CREATE INDEX IF NOT EXISTS "arenas_network_created_at_id_idx" ON "arenas"("network", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "pools_network_arena_id_idx" ON "pools"("network", "arena_id");
CREATE INDEX IF NOT EXISTS "rounds_network_arena_id_idx" ON "rounds"("network", "arena_id");
CREATE INDEX IF NOT EXISTS "transactions_network_user_id_idx" ON "transactions"("network", "user_id");
CREATE INDEX IF NOT EXISTS "elimination_logs_network_round_id_idx" ON "elimination_logs"("network", "round_id");
