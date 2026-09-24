# Performance Wave 4 Design Note

Issues: #1440, #1441, #1442, #1443.

## Ownership and state

- `contract/arena/src/storage.rs` owns the v2 all-player and active-survivor page indexes. `ArenaConfig` counts remain authoritative. Pages preserve join order; survivor pages are compacted after resolution.
- `backend/src/cache/cacheService.ts` owns typed Redis command execution, bounded retries, per-key TTL validation, and structured pipeline telemetry. `SessionStore` owns session command layout.
- `backend/src/queues/txQueue.ts` owns read-only BullMQ snapshots. `txReconciler.ts` owns job-attempt outcomes. `metrics.ts` owns Prometheus publication.
- `frontend/src/features/arena/arenaStore.ts` owns immutable arena snapshots. The live page starts polling/reconciliation through `useArenaStateActions` without subscribing its parent tree; panels subscribe through `useArenaState` or selectors. `Timer` remains local to its component.

## Transitions and signals

Arena joins append to the all-player and survivor tail pages. A round reads survivor pages, applies the existing elimination rules in join order, then rewrites survivor pages. A stale or inactive survivor entry is discarded and the full all-player index is used only as a self-healing fallback.

Runnable queue backlog is `waiting + prioritized + waiting-children`. Delayed retries and paused jobs are separate. Oldest age is the bounded age of the oldest runnable job. Saturation is `active / configured worker concurrency`; zero capacity is not healthy saturation. Throughput is the success-counter rate. Retry ratio is retry-attempt rate divided by attempt rate. Concurrent snapshot scrapes share one in-flight read.

Cache/session fan-out executes idempotent Redis commands in one pipeline. Transient failed commands retry up to three times; non-transient and exhausted failures raise a typed partial-failure error. Each cache/session write retains its supplied TTL.

Arena polling and reconciliation use request generations. A successful equivalent state keeps the previous state reference while `lastSyncedAt` advances. Retry/failure retains the last known state and changes health. Only a changed selected value rerenders a panel; timer ticks never publish to the arena store.

## Failure and compatibility

Redis snapshot failure keeps `/metrics` available, marks queue values unavailable, and preserves the distinction from a valid empty queue. Metrics failures do not alter queue processing. Pipeline retries are bounded and do not retry permanent command errors.

Existing REST, SSE, Soroban method signatures, arena event schemas, and frontend `useArenaState(arenaId)` return shape remain compatible. The contract storage version changes from 1 to 2. Read queries use a non-mutating legacy fallback; the next state-changing entry point migrates existing `PLAYERS` storage atomically to pages and then retires the legacy key. Pre-v2 WASM downgrade is unsupported.

## Verification

Tests cover page boundaries through 100 players, `u32::MAX`, migration/idempotency, stale survivor repair, cross-page elimination, retry behavior, and maximum-roster read budgets. Backend tests cover pipeline round trips, per-key TTLs, invalid/maximum input, transient/partial failure, queue empty/unavailable/concurrent states, retries, latency, and cross-module publication. Frontend tests cover equivalent/changed selections, stale concurrent responses, retries, invalid arena IDs, and timer isolation.
