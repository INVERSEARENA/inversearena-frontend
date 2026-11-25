# Web Push Notifications

## Overview

Batch web push notification system with:
- Bulk queueing via BullMQ `addBulk`
- Configurable concurrency and retries
- Per-endpoint-host rate limiting
- Automatic subscription pruning
- Delivery latency metrics

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Round Scheduler                          │
│                                                              │
│  Round phase changes (start, end, elimination)              │
│           │                                                  │
│           ▼                                                  │
│    ┌──────────────┐                                         │
│    │ PushService  │                                         │
│    │ sendAlertBulk│                                         │
│    └──────┬───────┘                                         │
└───────────┼──────────────────────────────────────────────────┘
            │
            │ addBulk (1000s of jobs in one call)
            ▼
   ┌────────────────────┐
   │    Push Queue      │
   │     (BullMQ)       │
   └────────┬───────────┘
            │
            │ Worker pulls jobs with concurrency=10
            ▼
   ┌────────────────────┐
   │   Push Worker      │
   │  (10 concurrent)   │
   │                    │
   │  - Rate limiting   │
   │  - Retry logic     │
   │  - Prune expired   │
   └────────┬───────────┘
            │
            │ Web Push API (FCM, APNs, etc.)
            ▼
   ┌────────────────────┐
   │   User Devices     │
   │  (1000s of users)  │
   └────────────────────┘
```

## Configuration

### Environment Variables

```bash
# VAPID Keys (generate with: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=BH...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@inversearena.com

# Redis (required for queue)
REDIS_URL=redis://localhost:6379

# Worker Configuration (optional)
PUSH_WORKER_CONCURRENCY=10
PUSH_RATE_LIMIT_PER_HOST=100  # requests per minute
```

### Worker Concurrency

The push worker processes notifications concurrently. Configure based on your infrastructure:

| Concurrency | Use Case |
|-------------|----------|
| 5 | Small arenas (<100 players) |
| 10 | Medium arenas (100-1000 players) |
| 20 | Large arenas (1000-5000 players) |
| 50+ | Very large arenas (5000+ players) |

Higher concurrency = faster fan-out but more load on push services.

## Usage

### Send Bulk Alert

```typescript
import { PushService } from './services/pushService';
import { createPushQueue } from './queues/pushQueue';

const pushQueue = createPushQueue();
const pushService = new PushService(pushQueue);

// Get subscriptions for all players in arena
const subscriptions = await getArenaPlayerSubscriptions(arenaId);

// Create alert
const alert: PushAlert = {
  id: 'alert-round-123',
  type: 'round_start',
  title: 'Round Starting!',
  body: 'A new round is about to begin in Arena Alpha',
  data: {
    arenaId,
    roundNumber: 5,
  },
  urgency: 'high',
  ttl: 300, // 5 minutes
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000), // Expires in 1 minute
};

// Bulk enqueue
const result = await pushService.sendAlertBulk(alert, subscriptions);
console.log(`Queued: ${result.queued}, Skipped: ${result.skipped}`);
```

### Start Worker

```typescript
import { startPushWorker } from './workers/pushWorker';

const worker = startPushWorker(pushService, {
  concurrency: 10,
  onSubscriptionPrune: async (subscriptionId) => {
    // Remove expired subscription from database
    await db.pushSubscriptions.delete(subscriptionId);
  },
});
```

## Alert Types

```typescript
type AlertType = 
  | 'round_start'      // Round is starting
  | 'round_end'        // Round has ended
  | 'elimination'      // Player eliminated
  | 'winner'           // Player won
  | 'payout'           // Payout processed
  | 'arena_update'     // Arena config changed
  | 'system';          // System notification
```

## Performance Targets

### Delivery Latency

| Metric | Target | Notes |
|--------|--------|-------|
| P50 | < 500ms | Median delivery time |
| P95 | < 2s | 95th percentile |
| P99 | < 5s | 99th percentile |

These targets apply from queue enqueue to push service response.

### Throughput

- **Small arena** (100 players): < 1 second fan-out
- **Medium arena** (1000 players): < 10 seconds fan-out
- **Large arena** (5000 players): < 60 seconds fan-out

Measured from `sendAlertBulk` call to last notification delivery.

## Edge Cases

### 1. Duplicate Sends After Worker Restart

**Problem:** Worker crashes mid-processing, restarts, processes same jobs again

**Solution:** Idempotency keys

```typescript
// Job ID includes alert+subscription
jobId: `push:${alert.id}:${subscription.id}`

// BullMQ prevents duplicate jobs with same ID
```

### 2. Push Service Throttling

**Problem:** Push services (FCM, APNs) rate limit per endpoint host

**Solution:** Built-in rate limiter

```typescript
// Rate limiter tracks requests per host
private checkRateLimit(host: string): Promise<boolean>

// Default: 100 requests/minute per host
// Configurable via PUSH_RATE_LIMIT_PER_HOST
```

### 3. Alerts That Become Stale

**Problem:** Round ends while notifications are still queuing

**Solution:** TTL and expiry checks

```typescript
const alert: PushAlert = {
  // ...
  ttl: 300, // 5 minutes
  expiresAt: new Date(Date.now() + 60_000), // Expires in 1 minute
};

// Worker checks before sending
if (alert.expiresAt && alert.expiresAt < Date.now()) {
  return { success: false, error: 'Alert expired' };
}
```

### 4. Expired Subscriptions

**Problem:** User unsubscribed or subscription expired

**Solution:** Automatic pruning

```typescript
// Worker detects HTTP 410/404 responses
if (error.statusCode === 410 || error.statusCode === 404) {
  result.shouldPrune = true;
}

// Callback removes from database
onSubscriptionPrune: async (subscriptionId) => {
  await db.pushSubscriptions.delete(subscriptionId);
}
```

## Metrics

### Prometheus Metrics

```
# Notifications sent successfully
push_notifications_sent_total{alert_type="round_start"} 1523

# Notifications failed
push_notifications_failed_total{alert_type="round_start",reason="delivery_failed"} 12

# Delivery latency histogram
push_delivery_latency_seconds{alert_type="round_start",quantile="0.95"} 1.8

# Subscriptions pruned
push_subscriptions_pruned_total{reason="expired"} 45

# Bulk enqueue size
push_bulk_enqueue_size_bucket{le="100"} 5
```

### Monitoring Dashboard

Recommended alerts:

```yaml
- alert: HighPushFailureRate
  expr: rate(push_notifications_failed_total[5m]) > 0.1
  annotations:
    summary: Push notification failure rate > 10%

- alert: SlowPushDelivery
  expr: histogram_quantile(0.95, rate(push_delivery_latency_seconds_bucket[5m])) > 5
  annotations:
    summary: P95 push delivery latency > 5s

- alert: HighSubscriptionPruneRate
  expr: rate(push_subscriptions_pruned_total[1h]) > 100
  annotations:
    summary: Pruning > 100 subscriptions per hour
```

## Testing

### Unit Tests

```bash
npm test push.unit.test.ts
```

Tests:
- Single notification sending
- Expired alert handling
- Subscription pruning logic
- Rate limiting
- Metrics calculation

### Integration Tests

```bash
npm test push.integration.test.ts
```

Tests:
- Bulk queueing
- Worker concurrency
- Duplicate prevention
- End-to-end flow

### Load Testing

Simulate large arena with many subscriptions:

```typescript
const subscriptions = generateMockSubscriptions(5000);
const alert = createMockAlert('round_start');

console.time('bulk-enqueue');
await pushService.sendAlertBulk(alert, subscriptions);
console.timeEnd('bulk-enqueue');
// Expected: < 500ms for 5000 subscriptions
```

## Troubleshooting

### Notifications Not Sending

1. Check VAPID keys configured:
   ```bash
   echo $VAPID_PUBLIC_KEY
   ```

2. Verify queue is running:
   ```bash
   redis-cli
   > KEYS push:*
   ```

3. Check worker logs:
   ```
   [PushWorker] Starting with concurrency: 10
   [PushWorker] Processing job ...
   ```

### Slow Delivery

1. Check P95 latency:
   ```
   curl http://localhost:3001/metrics | grep push_delivery_latency
   ```

2. Increase worker concurrency:
   ```bash
   export PUSH_WORKER_CONCURRENCY=20
   ```

3. Check rate limiting:
   ```
   [PushService] Rate limit exceeded for fcm.googleapis.com
   ```

### High Prune Rate

1. Check prune metrics:
   ```
   curl http://localhost:3001/metrics | grep push_subscriptions_pruned
   ```

2. Common causes:
   - Users unsubscribing
   - Browser sessions ending
   - Subscription keys rotating

3. Normal prune rate: 1-5% of active subscriptions per day

## Best Practices

1. **Set appropriate TTLs**
   - Time-sensitive alerts: 60-300 seconds
   - General updates: 3600-7200 seconds

2. **Use urgency levels**
   - `very-low`: Marketing, non-urgent updates
   - `low`: Arena updates, leaderboard changes
   - `normal`: Round phases (default)
   - `high`: Eliminations, wins, payouts

3. **Batch by arena**
   - Don't send individual alerts per player
   - Group all players in arena, send once

4. **Monitor metrics**
   - Track delivery latency
   - Alert on high failure rates
   - Watch prune rates for subscription health

5. **Handle edge cases**
   - Always set expiry times
   - Implement idempotency
   - Prune expired subscriptions

## References

- [Web Push Protocol (RFC 8030)](https://datatracker.ietf.org/doc/html/rfc8030)
- [VAPID (RFC 8292)](https://datatracker.ietf.org/doc/html/rfc8292)
- [BullMQ Documentation](https://docs.bullmq.io/)
- [FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/http-server-ref)
