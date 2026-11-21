import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export const register = new Registry();

// HTTP Metrics
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Database Connection Pool Metrics
export const dbPoolConnectionsActive = new Gauge({
  name: 'db_pool_connections_active',
  help: 'Number of active database connections in the pool',
  labelNames: ['role'],
  registers: [register],
});

export const dbPoolConnectionsIdle = new Gauge({
  name: 'db_pool_connections_idle',
  help: 'Number of idle database connections in the pool',
  labelNames: ['role'],
  registers: [register],
});

export const dbPoolWaitTime = new Histogram({
  name: 'db_pool_wait_time_seconds',
  help: 'Time spent waiting for a database connection from the pool',
  labelNames: ['role'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const dbPoolAcquireCount = new Counter({
  name: 'db_pool_acquire_total',
  help: 'Total number of connection acquisitions from the pool',
  labelNames: ['role', 'status'],
  registers: [register],
});

export const dbPoolTimeoutCount = new Counter({
  name: 'db_pool_timeout_total',
  help: 'Total number of connection pool timeout errors',
  labelNames: ['role'],
  registers: [register],
});

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['model', 'operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

// Worker Metrics
export const workerJobsPending = new Gauge({
  name: 'worker_jobs_pending',
  help: 'Number of pending worker jobs',
  labelNames: ['job_type'],
  registers: [register],
});

// Transaction Metrics
export const txsConfirmedTotal = new Counter({
  name: 'txs_confirmed_total',
  help: 'Total number of confirmed transactions',
  labelNames: ['status'],
  registers: [register],
});

// Round Metrics
export const roundResolutionsTotal = new Counter({
  name: 'round_resolutions_total',
  help: 'Total number of round resolutions',
  labelNames: ['status'],
  registers: [register],
});

export const roundResolutionDuration = new Histogram({
  name: 'round_resolution_duration_seconds',
  help: 'Round resolution duration in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});
