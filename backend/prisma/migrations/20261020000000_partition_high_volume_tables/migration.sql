-- Partition the two append-heavy, high-volume tables — `elimination_logs`
-- and `transactions` — by monthly RANGE on their timestamp columns, and
-- create the cold `archive` schema the retention worker moves aged
-- partitions into (#1622).
--
-- Notes:
--   * Primary keys on partitioned tables must include the partition key, so
--     both PKs become composite (id, <timestamp>). The `transactions`
--     unique constraint on `tx_hash` becomes (tx_hash, created_at) for the
--     same reason.
--   * Foreign keys FROM partitioned tables TO regular tables are supported
--     (PostgreSQL 12+; CI runs postgres:15). Constraint names keep the
--     Prisma convention so nothing downstream changes.
--   * Partitions cover 2026-01 through 2027-12 plus a DEFAULT partition.
--     Rows outside the covered range land in the default partition; the
--     retention worker (#1622) creates additional future months and
--     archives aged ones (see backend/docs/PARTITION_RETENTION_RUNBOOK.md).
--   * Existing rows are copied across; nothing is deleted.

CREATE SCHEMA IF NOT EXISTS "archive";

-- ── elimination_logs ────────────────────────────────────────────────────────

CREATE TABLE "elimination_logs_partitioned" (
  "id" TEXT NOT NULL,
  "round_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "reason" TEXT,
  "eliminated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "elimination_logs_partitioned_pkey" PRIMARY KEY ("id", "eliminated_at"),
  CONSTRAINT "elimination_logs_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "elimination_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
) PARTITION BY RANGE ("eliminated_at");

CREATE TABLE "elimination_logs_p2026_01" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "elimination_logs_p2026_02" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "elimination_logs_p2026_03" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "elimination_logs_p2026_04" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "elimination_logs_p2026_05" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "elimination_logs_p2026_06" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "elimination_logs_p2026_07" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "elimination_logs_p2026_08" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "elimination_logs_p2026_09" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "elimination_logs_p2026_10" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "elimination_logs_p2026_11" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "elimination_logs_p2026_12" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "elimination_logs_p2027_01" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "elimination_logs_p2027_02" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "elimination_logs_p2027_03" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "elimination_logs_p2027_04" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "elimination_logs_p2027_05" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "elimination_logs_p2027_06" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "elimination_logs_p2027_07" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "elimination_logs_p2027_08" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "elimination_logs_p2027_09" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "elimination_logs_p2027_10" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "elimination_logs_p2027_11" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "elimination_logs_p2027_12" PARTITION OF "elimination_logs_partitioned" FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');
CREATE TABLE "elimination_logs_p_default" PARTITION OF "elimination_logs_partitioned" DEFAULT;

INSERT INTO "elimination_logs_partitioned" ("id", "round_id", "user_id", "reason", "eliminated_at")
  SELECT "id", "round_id", "user_id", "reason", "eliminated_at" FROM "elimination_logs";

ALTER TABLE "elimination_logs" RENAME TO "elimination_logs_legacy";
ALTER TABLE "elimination_logs_partitioned" RENAME TO "elimination_logs";
DROP TABLE "elimination_logs_legacy";
ALTER INDEX "elimination_logs_partitioned_pkey" RENAME TO "elimination_logs_pkey";

CREATE INDEX "elimination_logs_round_id_idx" ON "elimination_logs"("round_id");
CREATE INDEX "elimination_logs_round_id_eliminated_at_id_idx" ON "elimination_logs"("round_id", "eliminated_at" DESC, "id" DESC);
CREATE INDEX "elimination_logs_user_id_idx" ON "elimination_logs"("user_id");

-- ── transactions ────────────────────────────────────────────────────────────

CREATE TABLE "transactions_partitioned" (
  "id" TEXT NOT NULL,
  "tx_hash" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transactions_partitioned_pkey" PRIMARY KEY ("id", "created_at"),
  CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
) PARTITION BY RANGE ("created_at");

CREATE UNIQUE INDEX "transactions_tx_hash_created_at_key" ON "transactions_partitioned"("tx_hash", "created_at");

CREATE TABLE "transactions_p2026_01" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "transactions_p2026_02" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "transactions_p2026_03" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "transactions_p2026_04" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "transactions_p2026_05" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "transactions_p2026_06" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "transactions_p2026_07" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "transactions_p2026_08" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "transactions_p2026_09" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "transactions_p2026_10" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "transactions_p2026_11" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "transactions_p2026_12" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "transactions_p2027_01" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "transactions_p2027_02" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "transactions_p2027_03" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "transactions_p2027_04" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "transactions_p2027_05" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "transactions_p2027_06" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "transactions_p2027_07" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "transactions_p2027_08" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "transactions_p2027_09" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "transactions_p2027_10" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "transactions_p2027_11" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "transactions_p2027_12" PARTITION OF "transactions_partitioned" FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');
CREATE TABLE "transactions_p_default" PARTITION OF "transactions_partitioned" DEFAULT;

INSERT INTO "transactions_partitioned" ("id", "tx_hash", "user_id", "amount", "type", "status", "created_at")
  SELECT "id", "tx_hash", "user_id", "amount", "type", "status", "created_at" FROM "transactions";

ALTER TABLE "transactions" RENAME TO "transactions_legacy";
ALTER TABLE "transactions_partitioned" RENAME TO "transactions";
DROP TABLE "transactions_legacy";
ALTER INDEX "transactions_partitioned_pkey" RENAME TO "transactions_pkey";

CREATE INDEX "transactions_user_id_idx" ON "transactions"("user_id");
CREATE INDEX "transactions_status_idx" ON "transactions"("status");
