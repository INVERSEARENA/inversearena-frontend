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
- Number of pending worker jobs
- Labels: `job_type`

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
