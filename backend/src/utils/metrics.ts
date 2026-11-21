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

// Proof Generation Metrics
export const proofGenerationDuration = new Histogram({
  name: 'proof_generation_duration_seconds',
  help: 'Proof bundle generation duration in seconds',
  labelNames: ['type'], // bundle or evidence
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const proofCacheHits = new Counter({
  name: 'proof_cache_hits_total',
  help: 'Total number of proof cache hits',
  labelNames: ['type'], // bundle or evidence
  registers: [register],
});

export const proofCacheMisses = new Counter({
  name: 'proof_cache_misses_total',
  help: 'Total number of proof cache misses',
  labelNames: ['type'], // bundle or evidence
  registers: [register],
});

export const proofStorageSize = new Gauge({
  name: 'proof_storage_bytes',
  help: 'Total size of proof artifacts in bytes',
  registers: [register],
});

export const proofArtifactsTotal = new Gauge({
  name: 'proof_artifacts_total',
  help: 'Total number of proof artifacts stored',
  labelNames: ['type'], // bundle or evidence
  registers: [register],
});
