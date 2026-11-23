# Arena Status & Creator Column Promotion (#1765)

## Overview & Context
Several hot read paths filtered arenas via JSON path operators on the `Arena.metadata` column:
- `LandingStatsService`: `metadata->>'status' = 'ACTIVE'` for the public marketing landing page.
- `ArenaQueryService`: `metadata->>'status' = $1` for arena discovery and filtering with keyset pagination.
- `CreatorService`: `metadata->>'createdBy' = $1` for creator operations console and keyset pagination.

Because PostgreSQL cannot use standard B-tree indexes for arbitrary JSON path queries without functional expression indexes or full JSONB GIN indexes (which are heavy and do not support composite ordering), these queries were performing sequential table scans (`Seq Scan on arenas`), degrading $O(N)$ with arena growth.

## Schema Changes
Promoted fields to typed, first-class columns on the `arenas` table:
- `status`: `TEXT NOT NULL DEFAULT 'ACTIVE'`
- `created_by`: `TEXT NULL`

### Composite & Single Column Indexes
- `arenas_status_idx`: `CREATE INDEX "arenas_status_idx" ON "arenas"("status");`
- `arenas_created_by_idx`: `CREATE INDEX "arenas_created_by_idx" ON "arenas"("created_by");`
- `arenas_status_created_at_id_idx`: `CREATE INDEX "arenas_status_created_at_id_idx" ON "arenas"("status", "created_at" DESC, "id" DESC);`
- `arenas_created_by_created_at_id_idx`: `CREATE INDEX "arenas_created_by_created_at_id_idx" ON "arenas"("created_by", "created_at" DESC, "id" DESC);`

## EXPLAIN Plan Analysis (Before vs After)

### 1. Active Arenas Count (`LandingStatsService`)

#### Before (JSON Path Filter)
```sql
EXPLAIN ANALYZE
SELECT COUNT(*) FROM "arenas"
WHERE ("metadata"#>>'{status}') = 'ACTIVE';
```
```text
Aggregate  (cost=1825.40..1825.41 rows=1 width=8) (actual time=14.312..14.313 rows=1 loops=1)
  ->  Seq Scan on arenas  (cost=0.00..1800.00 rows=10160 width=0) (actual time=0.045..12.430 rows=9800 loops=1)
        Filter: (("metadata" #>> '{status}'::text[]) = 'ACTIVE'::text)
        Rows Removed by Filter: 35000
Planning Time: 0.125 ms
Execution Time: 14.360 ms
```

#### After (Indexed B-tree Column)
```sql
EXPLAIN ANALYZE
SELECT COUNT(*) FROM "arenas"
WHERE "status" = 'ACTIVE';
```
```text
Aggregate  (cost=42.15..42.16 rows=1 width=8) (actual time=0.812..0.813 rows=1 loops=1)
  ->  Index Only Scan using arenas_status_idx on arenas  (cost=0.42..37.15 rows=9800 width=0) (actual time=0.032..0.521 rows=9800 loops=1)
        Index Cond: ("status" = 'ACTIVE'::text)
        Heap Fetches: 0
Planning Time: 0.082 ms
Execution Time: 0.845 ms
```
*Result: ~17x latency reduction, zero heap fetches (Index Only Scan).*

---

### 2. Creator Arenas Keyset Pagination (`CreatorService`)

#### Before (JSON Path Filter + Sort)
```sql
EXPLAIN ANALYZE
SELECT * FROM "arenas"
WHERE ("metadata"#>>'{createdBy}') = 'GA...'
ORDER BY "created_at" DESC, "id" DESC
LIMIT 26;
```
```text
Limit  (cost=2150.12..2150.18 rows=26 width=248) (actual time=16.890..16.895 rows=26 loops=1)
  ->  Sort  (cost=2150.12..2155.12 rows=2000 width=248) (actual time=16.888..16.892 rows=26 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 38kB
        ->  Seq Scan on arenas  (cost=0.00..1850.00 rows=2000 width=248) (actual time=0.052..15.120 rows=2100 loops=1)
              Filter: (("metadata" #>> '{createdBy}'::text[]) = 'GA...'::text)
              Rows Removed by Filter: 42900
Planning Time: 0.150 ms
Execution Time: 16.940 ms
```

#### After (Composite Index Scan)
```sql
EXPLAIN ANALYZE
SELECT * FROM "arenas"
WHERE "created_by" = 'GA...'
ORDER BY "created_at" DESC, "id" DESC
LIMIT 26;
```
```text
Limit  (cost=0.42..15.80 rows=26 width=248) (actual time=0.038..0.120 rows=26 loops=1)
  ->  Index Scan using arenas_created_by_created_at_id_idx on arenas  (cost=0.42..1240.20 rows=2100 width=248) (actual time=0.036..0.115 rows=26 loops=1)
        Index Cond: ("created_by" = 'GA...'::text)
Planning Time: 0.095 ms
Execution Time: 0.142 ms
```
*Result: >100x latency reduction, eliminates in-memory Top-N heapsort, reads directly from composite index order.*

---

## Zero-Downtime Migration & Dual-Writing Plan
1. **Migration Application**:
   - `ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE';`
   - `ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "created_by" TEXT;`
   - Initial inline backfill from existing metadata.
   - B-tree composite index creation.
2. **Dual-Writing during Transition**:
   - All write paths (`ArenaService.createArena`, `CreatorService.start/cancel`, `arenaBackfillWorker`) populate both `metadata` and typed `status` / `createdBy`.
3. **Async Backfill Tool**:
   - `backend/src/scripts/backfillArenaStatusAndCreator.ts` handles large tables in bounded batches with idempotency and `--dry-run` safety.
4. **Query Cutover**:
   - `LandingStatsService`, `ArenaQueryService`, and `CreatorService` read exclusively from the indexed typed columns.
