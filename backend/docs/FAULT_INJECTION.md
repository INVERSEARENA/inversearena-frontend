# Deterministic Fault Injection (#1461)

Test-only helpers in `backend/tests/helpers/faultInjection.ts` for injecting
timeouts, stale responses, duplicate delivery, and partial outages into the
RPC, Redis, and queue boundaries.

## Ownership

- `FaultInjector` owns the fault plan (ordered `FaultRule`s), per-operation
  call counters, last-good results (for `stale`), and the event log.
- Target wrappers own only the mapping of a call to `(operation, key)`:

| Target | Wrapper | Operation | Key |
|---|---|---|---|
| `rpc` | `createFaultyRpcServer(base, injector)` → `setRpcServerForTest` | `getAccount` / `simulateTransaction` | account id / contract function |
| `redis` | `createFaultyRedis(client, injector)` | command name | first string argument |
| `queue` | `new FaultQueueDelivery(processor, injector, { attempts })` | job name | job id |

`onChainReader.setRpcServerForTest` now accepts the narrow
`OnChainRpcServer` type (`getAccount` + `simulateTransaction`); a real
`rpc.Server` still satisfies it, so existing callers are unaffected.

## Determinism and state transitions

Each call increments the counter for `(target, operation)` and is matched
against rules in order; the first rule whose `target`, `operation`, `key`
prefix, `onCalls`, and remaining `times` match fires. No randomness or wall
clock is involved, so a fixed rule set over a fixed call sequence always
yields the same faults and the same event log.

## Failure behavior

| Kind | Effect |
|---|---|
| `timeout` | Rejects with `InjectedTimeoutError` (`ETIMEDOUT`); underlying op not called; no timers armed. |
| `outage` | Rejects with `InjectedOutageError` (`ECONNREFUSED`); with `key` it is a partial outage. |
| `stale` | Returns the last successful result for the same `(operation, key)`; `FaultConfigError` if none. |
| `duplicate` | Executes the underlying op twice and returns the second result. |

Invalid rules (unknown target/kind, non-positive `times`/`onCalls`) throw
`FaultConfigError` at construction. `FaultQueueDelivery` retries up to
`attempts`, marking attempts after the first as retries; configuration errors
are never retried. Redis pipelines/`multi` and event methods pass through.

## Observability

Every call appends a `FaultEvent` (`outcome`, `fault`, `retry`, `latencyMs`)
and logs it at `debug` with `subsystem: "fault-injection"`.
`injector.stats(target?)` aggregates success, failure, retry, fault counts,
and latency.

## Compatibility

Helpers live under `backend/tests` and are not compiled into `dist`. No REST,
Soroban, storage, or event contract changes.

Suite: `tests/faultInjection.unit.test.ts` (node:test, part of `npm run test:ci`).
