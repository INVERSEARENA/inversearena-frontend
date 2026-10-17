# Round Metadata Typed Persistence & Dual-Read Compatibility

Design note and operator runbook for #1523 — "Replace round metadata mutations with typed persistence columns".

## 1. Problem & Context

Previously, `Round` entity lifecycle-critical state was split between relational columns (`id`, `arena_id`, `round_number`, `state`, `created_at`, `updated_at`) and a generic JSON `metadata` document containing:
- `playerChoices` (array of player decisions and stakes)
- `oracleYield` (yield percentage float)
- `randomSeed` (entropy string)
- `allActivePlayerIds` (player IDs active at resolution time)
- `resolution` (eliminated players, payouts breakdown, pool balances)

### Current Limitations
1. Partial JSON mutation lacks relational database constraints and type enforcement.
2. Incompatible shapes and field omissions from different writers could be silently written.
3. Complex queries, indices, and analytical aggregations are obscured behind JSON blob parsing.

## 2. Authoritative Fields & Typed Persistence Model

The critical lifecycle subset is normalized directly onto the `rounds` table:

| Column Name | Database Type | Description | Authoritative Writer |
|---|---|---|---|
| `oracle_yield` | `DOUBLE PRECISION` (Nullable) | Yield percentage captured by oracle | `RoundService.resolveRound` / `RoundRepository` |
| `random_seed` | `TEXT` (Nullable) | Verifiable randomness seed | `RoundService.resolveRound` / `RoundRepository` |
| `player_choices` | `JSONB` (Nullable) | Array of validated player choice objects | `RoundRepository.resolveAtomically` |
| `all_active_player_ids` | `TEXT[]` (Default `[]`) | Array of active player IDs at resolution | `RoundRepository.resolveAtomically` |
| `resolution` | `JSONB` (Nullable) | Final round resolution and payout breakdown | `RoundRepository.saveResolution` |
| `metadata` | `JSONB` (Nullable) | Retained for backward-compatible fallback & extensible metadata | Dual-written during rollout |

### Invariants
1. When a round reaches `RESOLVED` or `SETTLED`, `oracle_yield`, `player_choices`, and `resolution` are guaranteed to be populated on the typed columns.
2. `all_active_player_ids` contains all active player IDs entering the round (revealers and non-revealers), ensuring proof bundles can be verified deterministically.
3. Legacy `metadata` JSON document is updated in lockstep (dual-write) throughout the transition wave.

## 3. Rollout Strategy & Dual-Read Compatibility

### Dual-Write Semantics
All mutating write paths (`RoundRepository.saveResolution`, `RoundRepository.resolveAtomically`) execute atomic updates writing both typed columns and the legacy JSON document.

### Dual-Read Semantics & Mismatch Telemetry
During rollout:
1. `RoundRepository.mapRound` checks for the presence of typed columns.
2. If typed columns are present, they are treated as authoritative.
3. If only legacy `metadata` is populated (pre-migration rows), the repository seamlessly falls back to legacy JSON extraction.
4. If both typed columns and legacy metadata are present, a comparison is performed. Any discrepancy triggers:
   - Prometheus counter: `inversearena_round_metadata_mismatches_total{field="<field_name>"}`
   - Structured warning log: `event: "round_metadata_mismatch"`

## 4. Backfill Job (`backfillRoundMetadata.ts`)

A standalone, resumable backfill service (`backend/src/scripts/backfillRoundMetadata.ts`) processes existing rows:
- **Resumable**: Stores progress in `BackfillCursor` with key `round_metadata_normalization`.
- **Idempotent**: Repeated executions safely re-check and skip already migrated rows.
- **Dry-runnable**: Supports `--dry-run` flag to validate existing metadata without mutating the database.
- **Conflict detection**: Invalid or malformed JSON payloads are reported and counted without halting execution.

### CLI Options
- `--dry-run`: Run validation pass without executing database writes.
- `--batch-size <number>`: Batch size per query (default: 100).
- `--limit <number>`: Maximum records to process in a single execution.

## 5. Dual-Read Removal Criteria

Dual-read fallback logic can be safely decommissioned when:
1. The backfill script has reached 100% completion across all environments (`BackfillCursor.lastProcessed` >= total rounds count).
2. Prometheus metric `inversearena_round_metadata_mismatches_total` has recorded **zero** mismatches for 14 consecutive days in production.
3. All consumers (Replay, Projection, Statistics, Proof Bundle) have been verified against typed columns in integration tests.

## 6. Operator Migration Runbook

### Step 1: Pre-Deployment Validation
Run dry-run backfill in staging / testnet to verify metadata integrity:
```bash
npm run tsx src/scripts/backfillRoundMetadata.ts --dry-run
```

### Step 2: Deploy Schema Migration & Dual-Write Code
Apply Prisma migration:
```bash
npx prisma migrate deploy
```
Deploy the backend service. The application will immediately begin dual-writing both typed columns and legacy metadata.

### Step 3: Execute Production Backfill
Run the backfill script:
```bash
npx tsx src/scripts/backfillRoundMetadata.ts --batch-size 200
```
Monitor progress via logs and Prometheus metrics (`inversearena_round_metadata_backfill_total`).

### Step 4: Verification & Monitoring
Verify `BackfillCursor` status:
```sql
SELECT * FROM backfill_cursors WHERE id = 'round_metadata_normalization';
```
Monitor Prometheus alert `inversearena_round_metadata_mismatches_total`.
