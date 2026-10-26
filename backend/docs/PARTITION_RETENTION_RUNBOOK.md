# Partitioning & Retention Runbook

Operates the monthly partitioning of the high-volume backend tables and the
retention worker that maintains it (#1622).

## What is partitioned

| Table | Partition key | Cadence | Retention |
|---|---|---|---|
| `elimination_logs` | `eliminated_at` | monthly | archived after `RETENTION_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS` (default 13) months |
| `transactions` | `created_at` | monthly | archived after `RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS` (default 13) months |

Both are PostgreSQL RANGE-partitioned parents created by migration
`20261020000000_partition_high_volume_tables`. Partition names follow
`<table>_pYYYY_MM`; out-of-range rows land in `<table>_p_default`.

Primary keys are composite (`id`, `<timestamp>`) and `transactions` uniqueness
on a tx hash is `(tx_hash, created_at)` — PostgreSQL requires the partition
key in every unique constraint. Application code that used
`findUnique({ where: { txHash } })` against the Prisma `Transaction` model
must use `findFirst` with a `createdAt` bound instead (no such call sites
existed when partitioning landed).

## Audit data is archived, never deleted

Aged partitions are **moved to the cold `archive` schema**, not dropped:

```sql
ALTER TABLE <table> DETACH PARTITION <table>_pYYYY_MM;
ALTER TABLE <table>_pYYYY_MM SET SCHEMA archive;
```

This is executed by the retention worker (below). History stays queryable
via `archive.<table>_pYYYY_MM` and can be restored into the hot parent.

## The retention worker

`backend/src/workers/retentionWorker.ts` — a plain class (no cron/BullMQ),
triggered by the admin-gated endpoint:

```bash
# Plan only — nothing is executed; actions are reported and counted with mode="planned"
curl -sS -X POST http://localhost:3001/api/worker/retention/run \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}' | jq

# Apply
curl -sS -X POST http://localhost:3001/api/worker/retention/run \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

Each run:

1. **Create-ahead** — ensures monthly partitions exist for the current month
   plus `PARTITION_AHEAD_MONTHS` (default 3) future months, so inserts never
   fail on a missing partition.
2. **Archive** — moves monthly partitions older than each table's retention
   window into the `archive` schema. `<table>_p_default` and partitions
   inside the window are never touched.
3. **Ephemeral cleanup** — deletes expired Mongo documents: auth nonces,
   refresh tokens, and expired transaction intents (the Mongo TTL indexes
   remain as a best-effort backstop; this makes cleanup deterministic and
   observable).

Runs are single-flight: a concurrent trigger while a run is in progress
returns a zero-action success immediately.

## Metrics

Scraped at `/metrics` (see docs/METRICS.md → Retention & Partition Metrics):

- `inversearena_retention_runs_total{status}` — run outcomes.
- `inversearena_retention_run_duration_seconds` — run latency.
- `inversearena_retention_partitions_created_total{table, mode}` — create-ahead actions; `mode` is `applied` or `planned` (dry-run).
- `inversearena_retention_partitions_archived_total{table, mode}` — archived partitions.
- `inversearena_retention_ephemeral_deleted_total{collection, mode}` — expired documents removed.
- `inversearena_retention_hot_partitions{table}` — monthly partitions currently attached.

## Alert thresholds

| Condition | Suggested threshold | Meaning |
|---|---|---|
| `retention_runs_total{status="failed"}` rate | > 0 for 2 runs | worker errors — inspect logs for `retention_error` |
| `retention_hot_partitions{table}` | < 2 | no headroom left for inserts — worker not running or failing to create-ahead |
| partition create warnings | any occurrence | see "Default-partition overlap" below |

Configuration (defaults in `backend/src/config/env.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PARTITION_AHEAD_MONTHS` | `3` | Future monthly partitions to keep created |
| `RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS` | `13` | Archive `transactions` partitions older than this |
| `RETENTION_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS` | `13` | Archive `elimination_logs` partitions older than this |

## Response procedures

### Insert failed with "no partition of relation found for row"

A future month's partition is missing (worker not run, or create failed).

1. Trigger a run: `POST /api/worker/retention/run`.
2. If creation fails again, check the warning text — likely the default
   partition holds in-range rows (below), or insufficient privileges.
3. Create the partition manually if needed:

   ```sql
   CREATE TABLE elimination_logs_p2028_01
     PARTITION OF elimination_logs
     FOR VALUES FROM ('2028-01-01') TO ('2028-02-01');
   ```

### Default-partition overlap ("conflicting/updated partition constraint")

Rows landed in `<table>_p_default` (typically future-dated rows written
before the covering partition existed). A new partition cannot be created
while the default holds rows in its range:

1. Find the misplaced rows:

   ```sql
   SELECT * FROM elimination_logs
   WHERE tableoid = 'elimination_logs_p_default'::regclass
     AND eliminated_at >= '2028-01-01' AND eliminated_at < '2028-02-01';
   ```

2. Detach the default, create the monthly partition (the rows move with the
   range check now passing), move the rows back through the parent, re-attach
   the default:

   ```sql
   BEGIN;
   ALTER TABLE elimination_logs DETACH PARTITION elimination_logs_p_default;
   CREATE TABLE elimination_logs_p2028_01 PARTITION OF elimination_logs
     FOR VALUES FROM ('2028-01-01') TO ('2028-02-01');
   INSERT INTO elimination_logs_p_default SELECT * FROM elimination_logs
     WHERE eliminated_at >= '2028-01-01' AND eliminated_at < '2028-02-01'
     AND tableoid = 'elimination_logs_p_default'::regclass;
   DELETE FROM elimination_logs_p_default
     WHERE eliminated_at >= '2028-01-01' AND eliminated_at < '2028-02-01';
   ALTER TABLE elimination_logs ATTACH PARTITION elimination_logs_p_default DEFAULT;
   COMMIT;
   ```

   (Detach first is required because PostgreSQL scans the default when
   attaching a new overlapping partition; an empty overlap attaches fine.)

### Restore an archived partition (incident: data needed back in hot queries)

1. Verify the partition exists and its range does not overlap anything
   currently attached:

   ```sql
   SELECT c.relname FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'archive' AND c.relname LIKE 'elimination_logs_p%';
   ```

2. Re-attach it — move it back to the public schema and attach:

   ```sql
   BEGIN;
   ALTER TABLE archive.elimination_logs_p2024_12 SET SCHEMA public;
   ALTER TABLE elimination_logs ATTACH PARTITION elimination_logs_p2024_12
     FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');
   COMMIT;
   ```

   If the attach fails with an overlap error, another partition now covers
   that month — resolve the overlap (usually by archiving the conflicting
   hot partition first) and retry.

3. Re-run `EXPLAIN` on the hot query (below) to confirm the restored
   partition is pruned correctly for recent-range predicates.

4. To archive it again later, either run the retention worker (its age is
   past the cutoff) or repeat the detach + `SET SCHEMA archive` manually.

### Verify partition pruning on a hot query

```sql
EXPLAIN (FORMAT TEXT)
SELECT el.id
FROM elimination_logs el
WHERE el.eliminated_at >= date_trunc('month', now())
  AND el.eliminated_at < date_trunc('month', now()) + interval '1 month';
```

The plan should scan exactly one `<table>_pYYYY_MM` child and never
`<table>_p_default`. `tests/integration/partitioning.test.ts` automates
these checks (run `npm run test:integration` with `DATABASE_URL` set).

## Prisma caveats

- Prisma does not understand declarative partitioning. The schema models the
  composite keys (`@@id([id, createdAt])`, `@@unique([txHash, createdAt])`),
  but `prisma migrate dev` cannot regenerate partitioned DDL: **future
  changes to these two tables must be hand-written SQL migrations** like the
  original one. If `migrate dev` reports drift it cannot resolve, write the
  SQL by hand and record it with
  `npx prisma migrate resolve --applied <migration_name>`.
- `prisma migrate deploy` (what `npm run migrate` and CI run) is unaffected:
  it only replays recorded SQL.
