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

// Push Notification Metrics
export const pushNotificationsSent = new Counter({
  name: 'push_notifications_sent_total',
  help: 'Total number of push notifications successfully sent',
  labelNames: ['alert_type'],
  registers: [register],
});

export const pushNotificationsFailed = new Counter({
  name: 'push_notifications_failed_total',
  help: 'Total number of failed push notifications',
  labelNames: ['alert_type', 'reason'],
  registers: [register],
});

export const pushDeliveryLatency = new Histogram({
  name: 'push_delivery_latency_seconds',
  help: 'Push notification delivery latency in seconds',
  labelNames: ['alert_type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const pushSubscriptionsPruned = new Counter({
  name: 'push_subscriptions_pruned_total',
  help: 'Total number of push subscriptions pruned (expired/invalid)',
  labelNames: ['reason'],
  registers: [register],
});

export const pushBulkEnqueueSize = new Histogram({
  name: 'push_bulk_enqueue_size',
  help: 'Number of push notifications in bulk enqueue operations',
  buckets: [1, 10, 50, 100, 500, 1000, 5000],
  registers: [register],
});
