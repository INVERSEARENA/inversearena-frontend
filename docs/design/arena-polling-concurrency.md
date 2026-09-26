# Bounded Concurrency and Backpressure for Arena Polling (#1433)

## Ownership and State Transitions

`ArenaPollConcurrencyLimiter` in `backend/src/cache/arenaPoller.ts` owns worker slot allocation, queue management, and backpressure shedding across all active arena poller loops.

Each arena poll task undergoes typed state transitions:
- **`IDLE`**: Poller is dormant or between scheduled polling intervals.
- **`QUEUED`**: Poller is waiting in the priority queue because active worker slots are saturated (`activePolls >= maxConcurrency`).
- **`POLLING`**: Poller is actively executing snapshot reads and verification against Soroban RPC / database.
- **`BACKOFF`**: Poller experienced execution error or backpressure shedding, applying exponential backoff before re-queueing.

### State Transition Diagram
```
[ IDLE ] ──(Trigger/Schedule)──> [ activePolls < maxConcurrency ] ──> [ POLLING ] ──(Success)──> [ IDLE ]
                                         │                                    │
                                         ▼ (activePolls saturated)            ▼ (RPC/DB Error)
                                [ QUEUED ] ──(Slot Freed)──> [ POLLING ]    [ BACKOFF ]
                                         │
                                         ▼ (queue.length >= maxQueueDepth)
                                [ BACKOFF (Shed) ]
```

## Failure Behavior and Backpressure

1. **Worker Slot Saturation**:
   When active in-flight poll count reaches `maxConcurrency` (default 20), incoming poll triggers are enqueued into a bounded queue up to `maxQueueDepth` (default 50).
2. **Backpressure Shedding**:
   When the queue is full (`queue.length >= maxQueueDepth`), excess poll triggers are shed rather than queued indefinitely. The poller records Prometheus metric `inversearena_arena_poller_backpressure_shed_total{reason="queue_full"}`, logs a structured warning (`arena_poller_backpressure_shed`), and defers to the next adaptive cadence tick.
3. **Single-Flight Deduplication**:
   Dual poll triggers for an arena that is already in `POLLING` or `QUEUED` state are deduplicated into a single in-flight operation to prevent redundant Soroban RPC load.
4. **RPC Slowdown Resilience**:
   During Soroban RPC latency spikes or network slowdowns, active pollers remain strictly clamped at `maxConcurrency`. Memory consumption and network handles remain bounded.

## Compatibility Constraints

1. **REST & SSE Endpoint Compatibility**:
   `subscribeArena` and `GET /api/arenas/:id/stream` preserve all existing event names (`snapshot`, `player_eliminated`, `round_resolved`, `game_finished`, `__heartbeat`), payload schemas, and SSE cursor `id` parameters without breaking contract or API schemas.
2. **Soroban & REST Versioning**:
   No Soroban ABI or REST envelope breaking changes are introduced.
3. **Operator Observability**:
   Prometheus metrics exported:
   - `inversearena_arena_poller_active_polls` (Gauge)
   - `inversearena_arena_poller_queue_depth` (Gauge)
   - `inversearena_arena_poller_backpressure_shed_total` (Counter)
   - `inversearena_arena_poller_poll_duration_seconds` (Histogram)
   - `inversearena_arena_poller_retries_total` (Counter)
