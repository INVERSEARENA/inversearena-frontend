# Arena boundary reliability

## Live-event cursors (#1384)

The backend poller owns monotonic per-arena sequence numbers and a bounded replay history. Clients retain the last applied sequence, reconnect with it, and discard duplicates. The HTTP route accepts `Last-Event-ID` or the compatible `cursor` query parameter and emits standard SSE `id` fields. A cursor still in history is replayed in order; an absent or stale cursor receives the latest snapshot. Structured logs report replay success and stale fallback. The existing event names and payloads remain compatible.

## Claim readiness (#1389)

`PaymentService` owns the versioned readiness decision. A claim is ready only when the contract is `Finished` and no submitted or confirmed payout record exists for that arena. RPC or record-read failures fail closed, so the UI never exposes a claim from partial state. The existing payout endpoints are unchanged; `GET /api/payouts/claim-readiness/:arenaId` adds the typed decision and structured success/failure latency logs.

## Payout lifecycle (#1390)

Transaction records own replacement links. The timeline endpoint groups every transaction sharing a payout ID, orders them by creation time, and preserves explicit replacement links while inferring links for legacy records. This keeps fee-bumped transactions in one timeline without changing existing transaction responses. Structured logs cover timeline success, failure, count, and latency. Operators should alert on repeated readiness/timeline failure logs and stale-cursor fallbacks.

## Bounded concurrency and backpressure (#1433)

`ArenaPollConcurrencyLimiter` in `backend/src/cache/arenaPoller.ts` enforces bounded worker slot allocation (`maxConcurrency`) and queue backpressure shedding (`maxQueueDepth`) for arena poller execution. Active poll tasks transition through typed state semantics (`IDLE` -> `QUEUED` -> `POLLING` -> `BACKOFF`). When Soroban RPC slowdown occurs, active concurrency stays clamped at `maxConcurrency`, and excess poll tasks are shed with backpressure counters (`inversearena_arena_poller_backpressure_shed_total`) and structured logs (`arena_poller_backpressure_shed`). Single-flight deduplication suppresses concurrent duplicate poll tasks per arena.

