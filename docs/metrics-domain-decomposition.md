# Domain-Owned Metrics Architecture (#1750)

## Overview & Context
Previously, `backend/src/utils/metrics.ts` held ~1,100 lines defining ~130 Prometheus metrics across all platform subsystems in a single global monolith. This resulted in:
- High contention and frequent merge conflicts across features.
- Risk of circular dependencies between domain code and central utilities.
- Lack of convention enforcement for metric prefixes, suffixes, and units.
- Unbounded label cardinality risks (#1274).

## Solution & Architecture
We have introduced a domain-owned metric registry helper and partitioned metrics into distinct domain modules co-located under `src/metrics/domains/`.

### 1. Registry Helper (`src/metrics/registry.ts`)
- **Naming & Prefix Enforcement**: Validates Prometheus identifiers and requires metrics to use `inversearena_` or approved legacy subsystem prefixes (`http_`, `worker_`, `round_`, `txs_`, etc.).
- **Units Enforcement**:
  - Counters must end with `_total`.
  - Histograms must specify units (e.g. `_seconds`, `_ms`, `_ledgers`).
- **Bounded Label Set Allowlist (Cardinality Guard #1274)**:
  - Enforces strict label allowlist to prevent unbounded dimensions (e.g. raw UUIDs, high-cardinality values).
- **Duplicate & Conflict Detection**:
  - Rejects registration of metrics with conflicting types.
- **Registry Reset**:
  - Provides `resetMetricsRegistry()` for test isolation.

### 2. Domain Modules
- `src/metrics/domains/http.metrics.ts`: HTTP request volumes and duration histograms.
- `src/metrics/domains/queue.metrics.ts`: BullMQ worker jobs, queue backlog, capacity, saturation ratios.
- `src/metrics/domains/poller.metrics.ts`: Arena polling cadence, wake triggers, backpressure, active arena counts.
- `src/metrics/domains/payments.metrics.ts`: Transaction confirmations, intent lifecycles, claim-inbox scans, active stake limits.
- `src/metrics/domains/round.metrics.ts`: Round resolutions, transitions, proof bundles, evidence packages.
- `src/metrics/domains/soroban.metrics.ts`: Soroban RPC circuit breakers, simulations, contract capabilities, WASM metadata caches.
- `src/metrics/domains/ops.metrics.ts`: Administrative audit chain, maintenance windows, partition retention, query budgets, TTL keeper.
- `src/metrics/domains/auth.metrics.ts`: Alias rotation, user authentication metrics.

### 3. Transition Strategy
`src/utils/metrics.ts` re-exports the registry and all domain metrics so that all existing consumers and test suites continue to work seamlessly without regressions. Grafana dashboards and Prometheus alerting queries remain completely unaffected because metric names and label structures remain unchanged.
