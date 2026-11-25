# PgBouncer Deployment Guide

## Overview

PgBouncer is a lightweight connection pooler for PostgreSQL that helps manage database connections efficiently, especially under horizontal scaling.

### Why PgBouncer?

**Problem:**
- Each process (API, workers, reconcilers) opens multiple database connections
- Under horizontal scaling, connection count multiplies: 10 pods × 10 connections = 100 connections
- Long-running worker transactions can starve API requests
- Postgres `max_connections` limit (typically 100-200) gets exhausted quickly

**Solution:**
- PgBouncer pools connections efficiently using transaction-level pooling
- Reduces active Postgres connections from 100+ to 20-30
- API requests get quick access to pooled connections
- Workers use separate pool configuration to prevent starvation

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Layer                         │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   API    │  │  Worker  │  │Reconciler│  │ Backfill │   │
│  │ Pool: 10 │  │ Pool: 5  │  │ Pool: 3  │  │ Pool: 2  │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │              │             │          │
└───────┼─────────────┼──────────────┼─────────────┼──────────┘
        │             │              │             │
        └─────────────┴──────────────┴─────────────┘
                            │
                ┌───────────▼────────────┐
                │      PgBouncer          │
                │  Transaction Pooling    │
                │  Pool Size: 25          │
                │  Max Connections: 100   │
                └───────────┬─────────────┘
                            │
                ┌───────────▼────────────┐
                │     PostgreSQL         │
                │  Max Connections: 200  │
                └────────────────────────┘
```

## Configuration

### Process Roles

Set `PROCESS_ROLE` environment variable to configure appropriate pool sizing:

| Role | Pool Size | Use Case |
|------|-----------|----------|
| API | 10 | Short-lived HTTP request handlers |
| WORKER | 5 | Payment worker, outbox dispatcher |
| RECONCILER | 3 | Transaction reconciliation |
| BACKFILL | 2 | Data backfill jobs |
| MIGRATION | 1 | Database schema migrations |

### Environment Variables

```bash
# Required: Database URL pointing to PgBouncer
DATABASE_URL=postgresql://user:pass@pgbouncer:6432/dbname

# Required: Process role
PROCESS_ROLE=API

# Optional: Override default pool size
DB_POOL_SIZE=10

# Optional: Pool timeout (seconds to wait for connection)
DB_POOL_TIMEOUT=20

# Optional: Connection timeout (seconds to establish TCP)
DB_CONNECTION_TIMEOUT=10
```

## Docker Compose Setup

### Development

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_MAX_CONNECTIONS: 200
    ports:
      - "5433:5432"  # Non-standard port to avoid conflict

  pgbouncer:
    image: edoburu/pgbouncer:1.21.0
    environment:
      DATABASE_URL: postgres://user:pass@postgres:5432/dbname
      POOL_MODE: transaction
      DEFAULT_POOL_SIZE: 25
      MAX_DB_CONNECTIONS: 100
    ports:
      - "5432:5432"  # Standard PostgreSQL port
    depends_on:
      - postgres

  api:
    build: .
    environment:
      DATABASE_URL: postgresql://user:pass@pgbouncer:5432/dbname
      PROCESS_ROLE: API
    depends_on:
      - pgbouncer

  worker:
    build: .
    environment:
      DATABASE_URL: postgresql://user:pass@pgbouncer:5432/dbname
      PROCESS_ROLE: WORKER
    depends_on:
      - pgbouncer
```

### Production (Kubernetes)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgbouncer-config
data:
  pgbouncer.ini: |
    [databases]
    inversearena = host=postgres port=5432 dbname=inversearena
    
    [pgbouncer]
    pool_mode = transaction
    max_client_conn = 1000
    default_pool_size = 25
    max_db_connections = 100
    # ... see pgbouncer.ini for full config

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbouncer
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: pgbouncer
        image: edoburu/pgbouncer:1.21.0
        ports:
        - containerPort: 6432
        volumeMounts:
        - name: config
          mountPath: /etc/pgbouncer
      volumes:
      - name: config
        configMap:
          name: pgbouncer-config

---
apiVersion: v1
kind: Service
metadata:
  name: pgbouncer
spec:
  ports:
  - port: 6432
    targetPort: 6432
  selector:
    app: pgbouncer
```

## Migrations

**Important:** Run migrations with direct Postgres connection, bypassing PgBouncer:

```bash
# Development
DATABASE_URL=postgresql://user:pass@localhost:5433/dbname \
PROCESS_ROLE=MIGRATION \
npm run migrate

# Production
DATABASE_URL=postgresql://user:pass@postgres:5432/dbname \
PROCESS_ROLE=MIGRATION \
npm run migrate
```

Why? PgBouncer's transaction pooling doesn't support DDL across multiple transactions.

## Edge Cases & Limitations

### 1. LISTEN/NOTIFY

**Problem:** Transaction pooling mode doesn't support `LISTEN`/`NOTIFY`

**Solution:** Use Redis pub/sub for real-time events instead

```typescript
// ❌ Won't work with PgBouncer transaction mode
await prisma.$queryRaw`LISTEN channel_name`;

// ✅ Use Redis instead
import { redis } from './redis';
await redis.subscribe('channel_name', (message) => {
  // Handle message
});
```

### 2. Prepared Statements

**Problem:** Prepared statements are transaction-scoped in transaction pooling

**Impact:** Minimal - Prisma handles this automatically

**Configuration:** Set `max_prepared_statements = 0` in PgBouncer config

### 3. SET Commands

**Problem:** `SET` commands don't persist across transactions

```typescript
// ❌ Won't persist across pooled connections
await prisma.$queryRaw`SET statement_timeout = 5000`;

// ✅ Set per-query or in connection string
DATABASE_URL=postgresql://...?options=-c%20statement_timeout=5000
```

### 4. Advisory Locks

**Problem:** Advisory locks are session-based

**Solution:** Use application-level locking (Redis) for distributed locks

```typescript
// ❌ Won't work reliably with transaction pooling
await prisma.$queryRaw`SELECT pg_advisory_lock(123)`;

// ✅ Use Redis for distributed locks
import { Redlock } from 'redlock';
const lock = await redlock.acquire(['resource:123'], 5000);
```

## Monitoring

### Metrics

The application exposes these connection pool metrics:

- `db_pool_connections_active{role}` - Active connections
- `db_pool_connections_idle{role}` - Idle connections
- `db_pool_wait_time_seconds{role}` - Wait time for connection
- `db_pool_timeout_total{role}` - Pool timeout errors
- `db_pool_acquire_total{role,status}` - Connection acquisitions

### PgBouncer Stats

Connect to PgBouncer admin console:

```bash
psql -h pgbouncer -p 6432 -U postgres pgbouncer

# View pool status
SHOW POOLS;

# View client connections
SHOW CLIENTS;

# View server connections
SHOW SERVERS;

# View stats
SHOW STATS;
```

### Alerts

Recommended Prometheus alerts:

```yaml
groups:
- name: database
  rules:
  - alert: HighPoolWaitTime
    expr: histogram_quantile(0.95, rate(db_pool_wait_time_seconds_bucket[5m])) > 0.1
    annotations:
      summary: High database pool wait time
      
  - alert: PoolSaturation
    expr: db_pool_connections_active / (db_pool_connections_active + db_pool_connections_idle) > 0.9
    annotations:
      summary: Database pool near saturation
```

## Load Testing

Run load tests to compare performance:

```bash
# Baseline (no PgBouncer)
DATABASE_URL=postgresql://user:pass@postgres:5432/dbname \
k6 run --vus 50 --duration 60s load-tests/connection-pooling.js

# With PgBouncer
DATABASE_URL=postgresql://user:pass@pgbouncer:6432/dbname \
k6 run --vus 50 --duration 60s load-tests/connection-pooling.js
```

Expected improvements:
- 30-50% reduction in P95 response time under load
- 10x more concurrent users before connection exhaustion
- Better tail latency (P99) performance

## Troubleshooting

### Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Fix:** Ensure PgBouncer is running and listening on correct port

```bash
docker-compose ps
netstat -an | grep 5432
```

### Pool Timeout

```
Error: timeout acquiring connection from pool
```

**Fix:** Increase pool size or timeout:

```bash
DB_POOL_SIZE=15
DB_POOL_TIMEOUT=30
```

### Too Many Connections

```
Error: FATAL:  sorry, too many clients already
```

**Fix:** Check PgBouncer `max_client_conn` and Postgres `max_connections`:

```sql
-- Check Postgres max connections
SHOW max_connections;

-- Check current connections
SELECT count(*) FROM pg_stat_activity;
```

## References

- [PgBouncer Documentation](https://www.pgbouncer.org/usage.html)
- [Prisma Connection Management](https://www.prisma.io/docs/concepts/components/prisma-client/working-with-prismaclient/connection-management)
- [PostgreSQL Connection Pooling Best Practices](https://www.postgresql.org/docs/current/runtime-config-connection.html)
