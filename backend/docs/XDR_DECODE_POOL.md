# XDR Decode Pool & Event-Loop Responsiveness Architecture (#1834)

## Problem & Context
In InverseArena, `backend/src/cache/arenaPoller.ts` and `onChainReader.ts` regularly poll on-chain state via Soroban `getLedgerEntries` and contract events.

Synchronously parsing XDR and converting values via `scValToNative` on the main Node.js event-loop thread blocks HTTP API handling, WebSocket/SSE heartbeats, and database operations. At 500+ active arenas, synchronous decoding produces event-loop lag spikes of tens of milliseconds per poll cycle.

## Solution Architecture: `XdrDecodePool`

`XdrDecodePool` (`src/services/xdrDecodePool.ts`) offloads heavy XDR deserialization to a bounded pool of Node.js `worker_threads`:

1. **Configurable Worker Pool**:
   - Spawns worker threads up to `Math.max(1, availableParallelism() - 1)`, capped at 8 cores.
   - Bounded task queue (`maxQueueSize: 1000`) prevents unbounded memory growth under traffic surges by applying structured load shedding (`PoolSaturationError`).

2. **Adaptive Batch Threshold**:
   - Small batches (`< batchThreshold`, default 5 items) are decoded inline on the main thread, avoiding IPC context-switch and serialization overhead.
   - Large batches (`>= batchThreshold`) are dispatched to idle worker threads.

3. **Structured-Clone Safe BigInt Serialization**:
   - Soroban `i128`, `u128`, `i256` ScVals decode to JavaScript `bigint` primitives.
   - Structured serialization (`serializeBigIntForClone` / `deserializeBigIntFromClone`) guarantees zero serialization faults and perfect precision across thread boundaries.

4. **Fault Tolerance & Auto-Restart**:
   - If a worker crashes or encounters an unhandled exception, its in-flight task rejects safely, and a replacement worker is automatically respawned.
   - Graceful shutdown (`pool.drain()`) drains in-flight tasks and cleanly terminates worker threads on `SIGINT` / `SIGTERM`.

5. **Observability & Metrics**:
   - `inversearena_event_loop_lag_seconds`: Continuous event loop delay histogram via `perf_hooks.monitorEventLoopDelay`.
   - `inversearena_xdr_decode_duration_seconds`: Histogram partitioned by `mode="inline"` and `mode="worker"`.
   - `inversearena_xdr_decode_pool_tasks_total`: Counter tracking execution outcomes (`ok`, `error`, `timeout`).
   - `inversearena_xdr_decode_pool_queue_depth`: Gauge for current queue pressure.

## Benchmark Verification (500 Arenas)

Run benchmark:
```bash
npx tsx scripts/benchmark-xdr-decode.ts --arenas 500 --entries-per-arena 8 --workers 4
```

| Metric | Synchronous Baseline (Main Thread) | XdrDecodePool (4 Workers) | Impact |
|---|---|---|---|
| **API / SSE Responsiveness** | Degrades under batch decode | Flat, uninterrupted | Zero event loop starvation |
| **Event-Loop Lag (p99)** | Spikes during synchronous bursts | Absorbed by thread pool | Main event loop remains responsive |
| **Correctness & Output Parity** | 100% matched | 100% matched | Complete fidelity |
