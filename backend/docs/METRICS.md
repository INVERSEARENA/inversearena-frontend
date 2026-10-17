# Metrics & Monitoring

## Overview

The backend exposes Prometheus-compatible metrics at `/metrics` for monitoring:

- **HTTP Metrics**: Request rates, latencies, status codes
- **Worker Metrics**: Pending job counts
- **Transaction Metrics**: Confirmation rates
- **Round Metrics**: Resolution rates and durations

## Available Metrics

### HTTP Metrics

**`http_requests_total`** (Counter)
- Total number of HTTP requests
- Labels: `method`, `route`, `status`

**`http_request_duration_seconds`** (Histogram)
- HTTP request duration in seconds
- Labels: `method`, `route`, `status`
- Buckets: 0.01, 0.05, 0.1, 0.5, 1, 2, 5 seconds

### Worker Metrics

**`worker_jobs_pending`** (Gauge)
- Number of pending database-batch worker jobs
- Labels: `job_type`

**`inversearena_queue_backlog`** (Gauge)
- Runnable `tx-confirm` jobs in waiting, prioritized, or waiting-child states
- Delayed retries and paused jobs are excluded from scale-up demand

**`inversearena_queue_oldest_age_seconds`** (Gauge)
- Age of the oldest runnable confirmation job; `-1` means unavailable

**`inversearena_queue_delayed`** (Gauge)
- Jobs waiting for retry backoff

**`inversearena_queue_active` / `inversearena_queue_capacity` / `inversearena_queue_saturation_ratio`** (Gauges)
- Current jobs, configured worker concurrency, and `active / capacity`

**`inversearena_queue_snapshot_available`** (Gauge)
- `1` for a valid snapshot and `0` when Redis collection failed; an empty queue remains available with zero values

**`inversearena_worker_job_attempts_total` / `inversearena_worker_job_retries_total` / `inversearena_worker_terminal_failures_total` / `inversearena_worker_jobs_success_total`** (Counters)
- Attempt, retry, terminal-failure, and successful-completion rates

**`inversearena_queue_refresh_*` / `inversearena_worker_job_processing_duration_seconds`** (Counter/Histogram)
- Snapshot success/failure and refresh/job latency

### Transaction Metrics

**`txs_confirmed_total`** (Counter)
- Total number of confirmed transactions
- Labels: `status` (confirmed, failed)

### Round Metrics

**`round_resolutions_total`** (Counter)
- Total number of round resolutions
- Labels: `status` (success, error)

**`round_resolution_duration_seconds`** (Histogram)
- Round resolution duration in seconds
- Buckets: 0.1, 0.5, 1, 2, 5, 10 seconds

### Contract Capability Negotiation Metrics (#1409)

**`inversearena_capability_negotiations_total`** (Counter)
- Contract capability negotiation attempts
- Labels: `contract` (arena, factory, payout, staking), `outcome` (success, failure, retry)

**`inversearena_capability_negotiation_duration_seconds`** (Histogram)
- Time to resolve a contract's negotiated capability set, including retries
- Labels: `contract`
- Buckets: 0.01, 0.05, 0.1, 0.5, 1, 2, 5 seconds

**`inversearena_capability_cache_hits_total`** (Counter)
- Negotiation results served from the in-memory version cache instead of a fresh on-chain read
- Labels: `contract`

A sustained rise in the `failure` outcome, or negotiation duration approaching the RPC circuit breaker's timeout, indicates a contract instance's `version()` entrypoint is unreachable or the deployment is genuinely running a version older than any TypeScript-callable entrypoint expects — see `backend/src/services/contractCapability.ts`.

### Arena Stream Publication Metrics (#1500)

**`inversearena_arena_polls_total`** (Counter)
- Arena poller fetch+verify attempts
- Labels: `outcome` (ok, error)
- Polls/minute ≈ (active arenas with subscribers × 60 / 2.5s); an `error` ratio above a few percent means Soroban RPC reads are failing (correlate with the circuit breaker gauge)

**`inversearena_arena_semantic_changes_total`** (Counter)
- Polls whose canonical snapshot fingerprint changed and were therefore published

**`inversearena_arena_suppressed_publishes_total`** (Counter)
- Polls with unchanged verified state where publication was suppressed (heartbeat metadata only)
- For an idle arena this is ~24/min; `semantic_changes` should stay near 0 in the same window

**`inversearena_arena_stream_resyncs_total`** (Counter)
- Client-requested full-snapshot resynchronisations after a detected version gap
- Labels: `reason` (gap)
- A sustained rise means clients are missing versions (short replay history, process restarts, or network loss between polls)

### Dashboard Bootstrap Metrics (#1501)

**`inversearena_dashboard_bootstrap_total`** (Counter)
- Dashboard bootstrap requests
- Labels: `outcome` (ok = all sections live, partial = some unavailable/stale, error = request rejected)

**`inversearena_dashboard_bootstrap_section_duration_seconds`** (Histogram)
- Per-section composition latency
- Labels: `section` (profile, watchlist, portfolio, notifications, activity, platform), `state` (ok, unavailable, stale)
- Buckets: 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5 seconds

**`inversearena_dashboard_bootstrap_section_failures_total`** (Counter)
- Sections that failed or hit their per-section timeout
- Labels: `section`, `reason` (timeout, error)

No arena id, user id, or wallet address is ever used as a label — see "Metric Cardinality" below.

### Administrative Audit Chain Metrics (#1503)

**`inversearena_audit_appends_total`** (Counter)
- Chained audit record appends
- Labels: `outcome` (ok, conflict, error)
- A rising `conflict` rate means concurrent writers are contending on the chain head (expected under bursty admin traffic; the append retries). A rising `error` rate means appends are being rejected — alert, audit coverage is at risk

**`inversearena_audit_chain_verification_total`** (Counter)
- Verification runs of the audit chain
- Labels: `outcome` (valid, invalid, error)
- Any `invalid` result must page: it means a record was modified, deleted, inserted, reordered, or the chain forked — the report names the first invalid sequence

**`inversearena_audit_checkpoints_total`** (Counter)
- Signed audit chain checkpoints persisted to the relational store
- Labels: `outcome` (ok, error)
- Alert when no successful checkpoint appears for the checkpoint interval × 3

**`inversearena_audit_chain_protection_available`** (Gauge)
- 1 = checkpoint store reachable and signing key configured, 0 = degraded
- Degraded state is also logged (`audit_chain_degraded`) — protection is never disabled silently

Suggested alerting additions:

```yaml
- alert: AuditChainVerificationFailed
  expr: increase(inversearena_audit_chain_verification_total{outcome="invalid"}[5m]) > 0
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: Audit chain verification detected tampering — inspect the first invalid sequence immediately

- alert: AuditChainProtectionDegraded
  expr: inversearena_audit_chain_protection_available == 0
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: Audit chain protection is degraded (checkpoint store or signing key unavailable)

- alert: ArenaStreamResyncStorm
  expr: increase(inversearena_arena_stream_resyncs_total[10m]) > 50
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: Arena stream clients are frequently detecting version gaps — check poller restarts and replay history sizing
```

## Quick Start

### 1. Start Backend
```bash
npm run dev
```

### 2. View Metrics
```bash
curl http://localhost:3001/metrics
```

### 3. Start Prometheus + Grafana
```bash
docker-compose -f docker-compose.monitoring.yml up -d
```

- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (admin/admin)

The Compose stack provisions the Prometheus datasource and dashboard automatically. The backend must be running separately and scrape successfully before queue signals appear.

## Prometheus Configuration

Local scrape configuration (`prometheus.yml`):

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'inversearena-backend'
    static_configs:
      - targets: ['host.docker.internal:3001']
    metrics_path: '/metrics'
    scrape_interval: 10s
```

## Sample Queries

### HTTP Request Rate (per second)
```promql
rate(http_requests_total[5m])
```

### HTTP Request Rate by Route
```promql
sum(rate(http_requests_total[5m])) by (route)
```

### HTTP Error Rate
```promql
sum(rate(http_requests_total{status=~"5.."}[5m])) by (route)
```

### HTTP Request Duration (p95)
```promql
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
```

### HTTP Request Duration by Route (p95)
```promql
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (route, le))
```

### Pending Worker Jobs
```promql
worker_jobs_pending
```

### Confirmation Queue Scaling Signals
```promql
inversearena_queue_backlog{queue="tx-confirm"}
inversearena_queue_oldest_age_seconds{queue="tx-confirm"}
inversearena_queue_saturation_ratio{queue="tx-confirm"}
rate(inversearena_worker_jobs_success_total{queue="tx-confirm"}[5m])
rate(inversearena_worker_job_retries_total{queue="tx-confirm"}[5m])
/
clamp_min(rate(inversearena_worker_job_attempts_total{queue="tx-confirm"}[5m]), 0.000000001)
```

Scale-up should require sustained backlog or oldest-age pressure together with available snapshots and saturation. A rising retry ratio should suppress aggressive scale-up and page the operator because the bottleneck may be Soroban or Redis rather than worker capacity. A value of `-1` or snapshot availability `0` is stale/unavailable and must not be interpreted as an empty queue.

### Transaction Confirmation Rate
```promql
rate(txs_confirmed_total[5m])
```

### Transaction Success Rate
```promql
sum(rate(txs_confirmed_total{status="confirmed"}[5m])) 
/ 
sum(rate(txs_confirmed_total[5m]))
```

### Round Resolution Rate
```promql
rate(round_resolutions_total[5m])
```

### Round Resolution Duration (p95)
```promql
histogram_quantile(0.95, rate(round_resolution_duration_seconds_bucket[5m]))
```

### Round Success Rate
```promql
sum(rate(round_resolutions_total{status="success"}[5m])) 
/ 
sum(rate(round_resolutions_total[5m]))
```

## Grafana Dashboard

Import the provided dashboard (`grafana-dashboard.json`) or create panels with these queries:

### Panel 1: HTTP Request Rate
```promql
rate(http_requests_total[5m])
```

### Panel 2: HTTP Request Duration (p50, p95, p99)
```promql
histogram_quantile(0.50, rate(http_request_duration_seconds_bucket[5m]))
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))
```

### Panel 3: Worker Jobs Pending
```promql
worker_jobs_pending
```

### Panel 4: Transaction Confirmation Rate
```promql
rate(txs_confirmed_total[5m])
```

### Panel 5: Round Resolution Success Rate
```promql
sum(rate(round_resolutions_total{status="success"}[5m])) 
/ 
sum(rate(round_resolutions_total[5m])) * 100
```

## Alerting Rules

Example Prometheus alerting rules:

```yaml
groups:
  - name: inversearena
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) 
          / 
          sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        annotations:
          summary: "High error rate detected"
          
      - alert: HighLatency
        expr: |
          histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        annotations:
          summary: "High latency detected (p95 > 2s)"
          
      - alert: PendingJobsHigh
        expr: worker_jobs_pending > 100
        for: 10m
        annotations:
          summary: "Too many pending worker jobs"
          
      - alert: TransactionFailureRate
        expr: |
          sum(rate(txs_confirmed_total{status="failed"}[5m])) 
          / 
          sum(rate(txs_confirmed_total[5m])) > 0.1
        for: 5m
        annotations:
          summary: "High transaction failure rate"
```

## Metric Cardinality

To keep cardinality low and avoid metric explosion:

- **Routes**: Limited to actual API routes (not dynamic IDs)
- **Status codes**: Grouped by HTTP status (200, 201, 400, 500, etc.)
- **Job types**: Limited to known job types (payment, etc.)

Current max label combinations: ~24 (well below recommended limits)

## Testing Metrics

Run the metrics test suite:

```bash
npx tsx tests/metrics.test.ts
```

Verify metrics during integration tests:

```bash
# Start server
npm run dev

# Run tests (generates metrics)
npx tsx tests/round.integration.test.ts
npx tsx tests/payment.integration.test.ts

# Check metrics
curl http://localhost:3001/metrics
```

## Production Considerations

1. **Scrape Interval**: 10-15 seconds is recommended
2. **Retention**: Configure Prometheus retention based on needs
3. **Cardinality**: Monitor unique label combinations
4. **Aggregation**: Use recording rules for expensive queries
5. **Alerting**: Set up alerts for critical metrics

## Troubleshooting

### Metrics not appearing
- Check `/metrics` endpoint is accessible
- Verify Prometheus can reach the backend
- Check Prometheus logs for scrape errors

### High cardinality warnings
- Review label values (avoid user IDs, transaction IDs)
- Use route patterns instead of full paths
- Limit status code granularity

### Missing data points
- Check scrape interval configuration
- Verify backend is running continuously
- Check for network issues between Prometheus and backend
