# Arena Discovery Backfill Job

Design note for #1391 — "Add factory-to-backend arena discovery backfill job".

## Problem

The backend's only path for learning about a new arena today is
`ArenaService.confirmArenaDeployment` (`backend/src/services/arenaService.ts`),
called from `POST /api/arenas` (`backend/src/routes/arenas.ts`). That flow is
**client-push, not event-driven**: the host's wallet calls `create_pool` on the
factory contract directly (the factory requires the host's own signature to
move their stake — the backend cannot submit on their behalf), then the client
separately calls `POST /api/arenas` with the resulting `txHash`, and the
backend verifies the transaction on-chain and writes the `Arena` row.

There is no background listener anywhere in the backend that watches the
factory contract for new pools. `backend/src/cache/arenaPoller.ts` (the only
existing "poller" in the codebase) is unrelated: it polls a single **already
known** arena's live round state for SSE fan-out to spectators, not factory
pool creation.

Consequently, any `create_pool` that succeeds on-chain without its client-side
confirmation call landing — page closed before the second request, network
drop, client crash, the confirmation request itself failing validation or
timing out — leaves that arena **permanently invisible** to the backend. It
exists on-chain (the factory recorded it, the host's stake was collected, the
arena contract is live and joinable via a direct contract call) but the
backend's DB, REST API, and anything built on top of it (stats, leaderboard,
notifications) never learn it exists. This is the "downtime/gap" problem the
issue describes, except the outage is client-side reliability, not a backend
process being down — the fix is the same either way: a reconciliation pass
that scans the factory's authoritative state and fills in whatever the
push path missed.

## Ownership

The backfill job lives in `backend/src/workers/arenaBackfillWorker.ts`
(new), following the existing `PaymentWorker` shape
(`backend/src/workers/paymentWorker.ts`): a plain class with a
`processBatch()` method, no BullMQ, no cron library. It is invoked the same
way `PaymentWorker` is — an admin-gated HTTP trigger
(`POST /api/worker/arena-backfill/run`, wired the same way
`POST /api/worker/run` wires `PaymentWorker` in
`backend/src/routes/worker.ts` / `backend/src/controllers/worker.controller.ts`
/ `backend/src/app.ts`). An external scheduler (cron, k8s CronJob, Render/
Railway scheduled job — whatever already triggers periodic HTTP calls in this
deployment, which is out of this repo) hits that endpoint on an interval. This
matches the codebase's existing convention: there is no in-process interval
timer or job-queue library already used for "scan and reconcile" work
(`PaymentWorker` itself is triggered the same way, not self-scheduling), so
the backfill job does not invent one either.

`onChainReader.ts` gains the read-only chain-query function the worker calls
(`getFactoryArenaPage`) — consistent with its existing role as the one module
that talks to Soroban RPC for read paths. The worker owns orchestration
(paging, cursor advancement, DB upserts, metrics); the reader owns the RPC
call and the `ArenaMetadata` decode/validation.

Note: the factory contract has no public "total pool count" entry point —
`FactoryStorage::pool_count` (`contract/factory/src/storage.rs`) is an
internal storage helper used inside `get_arenas`, not something exposed on
the contract's `#[contractimpl]` surface. So there is no `getFactoryPoolCount`
function, and none is needed: the worker detects the end of the list purely
from `get_arenas` returning fewer than `limit` results (see "Discovery
mechanism" below), which requires no new contract surface.

## Discovery mechanism: state query, not event-log scan

The factory contract does not expose a "query by ledger range" entry point,
and nothing in this codebase today calls Soroban RPC's `getEvents` (checked:
`onChainReader.ts` only ever calls `simulateTransaction` for read-only view
calls). Introducing `getEvents`-based historical event scanning would be a new
RPC integration pattern with its own retention-window and pagination-token
semantics that nothing else here uses.

The factory already exposes exactly the state this job needs as a plain view
call:

- `get_arenas(offset: u32, limit: u32) -> Vec<ArenaMetadata>` — pools in
  creation order (`pool_id` ascending), page size capped at `MAX_PAGE_SIZE =
  50` server-side (`contract/factory/src/lib.rs`).
- `ArenaMetadata { arena_address, pool_id, host, entry_fee, status,
  created_at }` — `arena_address` is exactly the value
  `confirmArenaDeployment` already uses as `Arena.id`.

**Decision**: the backfill pages through `get_arenas` by `pool_id`, not by
ledger sequence. `pool_id` is a monotonically increasing counter assigned by
`FactoryStorage::next_pool_id` at `create_pool` time
(`contract/factory/src/lib.rs:284`), so it is already a total order over
arena creation with no gaps (every pool_id from 1..pool_count exists). This
is a deliberate, conservative choice made because it reuses an existing,
already-paginated, already-tested contract entry point instead of adding a
new one, and reads current authoritative contract state rather than replaying
historical events (immune to RPC event-retention windows and to any given
event being missed/reordered upstream). It also does **not** require any
contract change — `get_arenas` and `ArenaMetadata` already carry everything
needed.

**Flagged for revisiting**: if the team wants the backfill to also be able to
answer "when did this happen" independent of pool_id order, or to align with
a future ledger-sequence-based indexer for other event types, a
`getEvents`-based path would need to be added as a separate integration.
`pool_id` order was chosen here specifically because it requires zero new RPC
surface and the existing `ArenaMetadata.created_at` (ledger timestamp) is
still available per-record for observability/debugging even though it isn't
the paging key.

**`ArenaStatus` decode note** (verified empirically against the real contract
encoding via a local `cargo test` dump, not assumed): `ArenaStatus`
(`contract/factory/src/types.rs`) is a fieldless Rust enum. soroban-sdk's
`#[contracttype]` derive encodes a fieldless variant as a **one-element
`ScVec` containing the variant's `Symbol`** (e.g. `Vec([Symbol("Active")])`),
not a bare `Symbol`. `scValToNative` therefore decodes `entry.status` to a
one-element array (`["Active"]`), never the string `"Active"` directly.
`decodeArenaMetadata` (`onChainReader.ts`) unwraps this
(`Array.isArray(entry.status) ? entry.status[0] : entry.status`) before
comparing against the known `FactoryArenaStatus` values — a naive direct
string comparison would reject every real on-chain record and make the
backfill permanently non-functional against a live contract. Covered by the
"all four ArenaStatus variants decode correctly" test in
`onChainReader.factoryArenaPage.unit.test.ts`.

## State: cursor storage

New Prisma model, `BackfillCursor`:

```prisma
model BackfillCursor {
  id            String   @id // e.g. "arena_discovery"
  lastProcessed Int      @default(0) @map("last_processed") // last pool_id fully processed
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@map("backfill_cursors")
}
```

A single row keyed by job name (`"arena_discovery"`), not a one-off env var or
in-memory value, so the cursor survives restarts and is inspectable/resettable
by an operator via a normal DB read. This is a new, minimal pattern — nothing
in the current schema already tracks "last processed X" for any job, so there
is no existing convention to extend (checked `schema.prisma` in full: `Arena`,
`Pool`, `Round`, `Transaction`, `EliminationLog`, `User` — none carry a
cursor/sequence field). Keying by job name rather than hard-coding a singleton
row lets a future second backfill-style job (e.g. one for a different
contract) reuse the same table without a migration.

Cursor semantics: `lastProcessed = N` means pool_ids `1..=N` have been
upserted into `Arena` (or confirmed not to exist, for gaps — there are none by
construction, since `next_pool_id` is sequential and starts at 1). The next
run starts at offset `N` (`get_arenas(N, limit)`, since `get_arenas`'s
`offset` is "number of pools to skip" and pool_ids are 1-indexed).

## Failure behavior

- **Commit granularity: per-arena, not per-batch.** Each page from
  `get_arenas` is processed one `ArenaMetadata` entry at a time; the cursor
  only advances past a given `pool_id` after that arena's upsert has
  committed. If the worker crashes or throws mid-page, `lastProcessed` reflects
  exactly how far it got — no arena is skipped, and at most the
  already-committed arenas in that page are re-read (harmlessly re-upserted)
  on the next run. This was chosen over per-batch commit because per-batch
  would either (a) require a DB transaction wrapping N upserts plus N RPC
  round-trip results, which is unnecessary coupling for independent records,
  or (b) risk losing an entire page's progress on a late failure (e.g. arena
  40 of 50 fails) and reprocessing 39 already-successful upserts for no
  benefit. Per-arena costs one extra cursor write per arena; at `MAX_PAGE_SIZE
  = 50` and realistic backfill volumes this is not a meaningful performance
  concern, and it is the simplest correct option.
- **A single arena's upsert failing** (malformed data, DB error) is logged
  with structured context and counted in the run's `failed` total; the worker
  continues to the next arena rather than aborting the whole run. The cursor
  does **not** advance past a failed pool_id, so it is retried on the next
  scheduled run automatically — no separate retry/backoff bookkeeping is
  needed because the next interval run already re-attempts anything the
  cursor didn't clear.
- **An RPC/network failure reading a page** (the `get_arenas` call itself
  throws) aborts the current run immediately without advancing the cursor
  past that page, logs the error, increments a failure metric, and returns a
  result summary marking the run as failed. The next scheduled run retries
  from the same cursor position — this mirrors how `PaymentWorker` and
  `txReconciler` treat unretried failures as "leave state as-is, let the next
  scheduled attempt pick it up" rather than building bespoke in-job retry
  loops.
- **Unreconcilable state**: none is expected by construction (pool_ids are
  contiguous and `arena_address` from the contract is always a valid deployed
  address), but if `get_arenas` ever returns an `ArenaMetadata` whose
  `arena_address` fails the same `CONTRACT_ID_REGEX` validation
  `arenaService.ts` already applies to deployment confirmations, that single
  record is treated as an invalid-input failure (logged, counted, cursor not
  advanced past it) rather than crashing the run or silently accepting bad
  data into `Arena.id`.

## Idempotency / concurrency

`Arena.id` **is** the arena's on-chain contract address (confirmed in
`arenaService.ts::confirmArenaDeployment`, which writes
`prisma.arena.create({ data: { id: arenaId, ... } })` where `arenaId` is the
decoded factory return value). The backfill upserts by that same key:

```ts
await prisma.arena.upsert({
  where: { id: arenaMetadata.arena_address },
  create: { id: arenaMetadata.arena_address, metadata: {...} },
  update: {}, // never overwrite fields the push/confirm path or later
              // gameplay writes may have already set — see below
});
```

This makes every edge case in the issue's list safe by construction:

- **Duplicate delivery / re-running the backfill**: `upsert` on the primary
  key is a no-op update for an already-known arena.
- **Concurrent requests / overlap with the primary confirm path**: if a
  client's `POST /api/arenas` confirmation and a backfill run race on the same
  `arena_address`, both are `upsert`s on the same primary key — Postgres
  serializes them, the later writer's `update` clause (which the backfill
  intentionally leaves as a no-op) never clobbers fields the confirm path
  wrote first (e.g. `metadata.createdBy`, `metadata.deployment.txHash`). The
  backfill's `create` branch only fires if the row genuinely does not exist
  yet, so it never loses information the richer confirm-path write already
  has; it only ever fills in arenas that path never reached.
- **Partial failure / restart mid-run**: covered above under Failure
  behavior — the per-arena cursor commit means a restart resumes at the exact
  next unprocessed `pool_id`.

## Compatibility

- No REST or Soroban ABI changes. `get_arenas`/`ArenaMetadata` are read
  as-is; the factory contract is untouched.
- The new `Arena.metadata` shape written by the backfill is a strict subset of
  the fields `confirmArenaDeployment` already writes (`contractAddress`,
  `entryFee`, plus a `deployment.status: "backfilled"` marker instead of
  `"confirmed"` so operators can distinguish how a row was created — this is
  additive to the existing free-form `Json?` field, not a schema change).
  Nothing reads `metadata.deployment.status` today, so this is not a breaking
  change to any consumer.
- New `BackfillCursor` table is additive (new Prisma model + migration), no
  existing table is altered.
- **Network**: the worker calls the same `getStellarConfig()`
  (`backend/src/config/stellarConfig.ts`) and `ARENA_FACTORY_CONTRACT_ID` env
  var that `onChainReader.ts` / `arenaService.ts` already use, so it
  automatically follows whatever network (testnet/mainnet) the rest of the
  backend is configured for. It does not hardcode a network or RPC URL.

## Edge cases (explicit mapping to the issue's list)

| Edge case | Handling |
|---|---|
| Duplicate delivery | `upsert` by `Arena.id` (contract address) |
| Stale reads | Cursor never advances past an unprocessed page; a page read with a stale view of `pool_count` simply yields fewer results this run and the rest is picked up next run — never "misses forever" |
| Partial failure | Per-arena cursor commit; failed arena retried next run |
| Restart during work | Cursor persisted in DB, not memory; resumes at `lastProcessed` |
| Network mismatch | Uses shared `getStellarConfig()` / `ARENA_FACTORY_CONTRACT_ID`, same as rest of backend |
| Maximum-size input | Pages in batches of `MAX_PAGE_SIZE` (50, matching the contract's own cap); loop bounded by a configurable `maxPagesPerRun` so one run cannot scan unboundedly and blocks the event loop / holds RPC connections open indefinitely |
| Concurrent requests | Upsert-by-primary-key is safe under concurrent writers (backfill vs. confirm-path vs. a second backfill run); see Idempotency section |
| Invalid input (malformed on-chain data) | Contract-address regex validation per record; failing records are logged/counted and skipped without advancing the cursor past them |

## Observability

Following the existing `pino` logger (`backend/src/utils/logger.ts`) and
`prom-client` metrics (`backend/src/utils/metrics.ts`) conventions:

- `logger.info`/`warn`/`error` with structured fields (`poolId`,
  `arenaAddress`, `cursor`, `durationMs`) at run start, run end, and per-arena
  failure — matching the field-object-then-message pino call shape already
  used throughout (`paymentWorker.ts`, `txReconciler.ts`).
- New metrics in `backend/src/utils/metrics.ts`:
  - `inversearena_backfill_runs_total{status}` (Counter; `status` =
    `success`|`failed`)
  - `inversearena_backfill_arenas_discovered_total` (Counter)
  - `inversearena_backfill_arenas_failed_total` (Counter)
  - `inversearena_backfill_run_duration_seconds` (Histogram)
  - `inversearena_backfill_cursor_position` (Gauge) — lets an operator alert
    if the cursor stops advancing relative to the factory's live
    `pool_count`.

## Operator runbook: triggering and monitoring

**Trigger a backfill pass** — admin-gated HTTP endpoint, same auth as every
other worker endpoint (`ADMIN_API_KEY` bearer token via `requireAdmin`):

```bash
curl -X POST https://<backend-host>/api/worker/arena-backfill/run \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Response body is `ArenaBackfillRunResult`:

```json
{
  "status": "success",
  "discovered": 3,
  "failed": 0,
  "cursor": 142,
  "pagesRead": 1,
  "durationMs": 812
}
```

`status: "failed"` (with an `error` field) means the run aborted on an
RPC/page-read failure without losing progress — the cursor is unchanged from
before the run, safe to retry immediately or on the next scheduled interval.

**Schedule it**: this repo does not run its own cron/interval timer for
worker jobs (matches `PaymentWorker`'s existing trigger model). In
production, point an external scheduler (k8s `CronJob`, Render/Railway
scheduled job, cron hitting the endpoint via `curl`) at the endpoint above on
whatever interval matches the acceptable discovery-latency window (e.g. every
5–15 minutes). This is infrastructure configuration outside this repo.

**Monitor**:
- `GET /metrics` (Prometheus) exposes the five `inversearena_backfill_*`
  metrics listed above. A good alert: `inversearena_backfill_cursor_position`
  not advancing for N consecutive scheduled intervals, or
  `inversearena_backfill_runs_total{status="failed"}` incrementing on
  consecutive runs.
- Structured logs (`pino`, JSON): search for `"msg":"ArenaBackfillWorker.run"`
  — `backfill pass complete` on success (includes `startCursor`, `cursor`,
  `discovered`, `failed`, `pagesRead`, `durationMs`), `factory page read
  failed, aborting run` on an RPC failure, `arena upsert failed, will retry
  next run` per bad record.

**Inspect/reset the cursor manually** (operator DB access): the cursor is a
single row, `backfill_cursors` table, `id = 'arena_discovery'`,
`last_processed` column. Reading it shows exactly how far the backfill has
gotten; it is safe to read at any time (no locking). It should not normally
need manual editing — a lower value would just cause some already-processed
pool_ids to be re-read and no-op-upserted (never duplicated, see
Idempotency), so this is also a safe way to force a full re-scan if ever
needed for auditing.

## Out of scope (per issue)

- No change to the primary real-time discovery/confirmation path
  (`confirmArenaDeployment`, `POST /api/arenas`) — this is purely additive
  reconciliation.
- No contract changes.
- No new external vendor/service.
- Does not touch `reindexPool` (`backend/src/controllers/admin.controller.ts`)
  or `runReconciliation` — both are pre-existing, unrelated admin endpoints
  (single-pool state repair and payment-transaction reconciliation,
  respectively; `reindexPool` is a documented 501 stub for a different,
  not-yet-built feature).
