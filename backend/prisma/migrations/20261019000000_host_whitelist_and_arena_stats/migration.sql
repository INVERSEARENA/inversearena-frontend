CREATE TABLE "arena_stats" (
  "id" TEXT NOT NULL,
  "arena_id" TEXT NOT NULL,
  "players" INTEGER NOT NULL DEFAULT 0,
  "rounds" INTEGER NOT NULL DEFAULT 0,
  "eliminations" INTEGER NOT NULL DEFAULT 0,
  "yield_accrued" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "arena_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "arena_stats_arena_id_key" ON "arena_stats"("arena_id");
ALTER TABLE "arena_stats" ADD CONSTRAINT "arena_stats_arena_id_fkey" FOREIGN KEY ("arena_id") REFERENCES "arenas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "host_whitelist_applications" (
  "id" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "contact" TEXT NOT NULL,
  "intent" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reviewer" TEXT,
  "review_note" TEXT,
  "unsigned_xdr" TEXT,
  "tx_hash" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "reviewed_at" TIMESTAMP(3),
  "confirmed_at" TIMESTAMP(3),
  CONSTRAINT "host_whitelist_applications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "host_whitelist_applications_wallet_status_idx" ON "host_whitelist_applications"("wallet", "status");
CREATE INDEX "host_whitelist_applications_status_created_at_idx" ON "host_whitelist_applications"("status", "created_at" DESC);
