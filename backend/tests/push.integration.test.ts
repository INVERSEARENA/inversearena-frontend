import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Queue } from 'bullmq';
import { PushService } from '../src/services/pushService';
import { createPushQueue, PUSH_QUEUE } from '../src/queues/pushQueue';
import { startPushWorker } from '../src/workers/pushWorker';
import type { PushAlert, PushSubscription } from '../src/types/push';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({ statusCode: 201 }),
}));

describe('Push Service Integration', () => {
  let pushQueue: Queue;
  let pushService: PushService;
  let worker: any;

  const mockSubscriptions: PushSubscription[] = [
    {
      id: 'sub-1',
      userId: 'user-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/endpoint1',
      keys: { p256dh: 'key1', auth: 'auth1' },
      createdAt: new Date(),
    },
    {
      id: 'sub-2',
      userId: 'user-2',
      endpoint: 'https://fcm.googleapis.com/fcm/send/endpoint2',
      keys: { p256dh: 'key2', auth: 'auth2' },
      createdAt: new Date(),
    },
    {
      id: 'sub-3',
      userId: 'user-3',
      endpoint: 'https://fcm.googleapis.com/fcm/send/endpoint3',
      keys: { p256dh: 'key3', auth: 'auth3' },
      createdAt: new Date(),
    },
  ];

  const mockAlert: PushAlert = {
    id: 'alert-integration-test',
    type: 'round_start',
    title: 'Integration Test Alert',
    body: 'Testing bulk push notifications',
    urgency: 'normal',
    ttl: 3600,
    createdAt: new Date(),
  };

  beforeAll(async () => {
    // Create queue and service
    pushQueue = createPushQueue();
    pushService = new PushService(pushQueue);

    // Start worker with low concurrency for testing
    worker = startPushWorker(pushService, {
      concurrency: 2,
      onSubscriptionPrune: async (subscriptionId) => {
        console.log(`Test: Pruning subscription ${subscriptionId}`);
      },
    });

    // Clean up queue before tests
    await pushQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await worker?.close();
    await pushQueue?.close();
  });

  it('should enqueue multiple notifications in bulk', async () => {
    const result = await pushService.sendAlertBulk(
      mockAlert,
      mockSubscriptions
    );

    expect(result.queued).toBe(3);
    expect(result.skipped).toBe(0);

    // Wait a bit for queue to populate
    await new Promise((resolve) => setTimeout(resolve, 100));

    const counts = await pushQueue.getJobCounts('waiting', 'active');
    expect(counts.waiting + counts.active).toBe(3);
  });

  it('should process jobs with concurrency', async () => {
    // Add jobs
    await pushService.sendAlertBulk(mockAlert, mockSubscriptions);

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const counts = await pushQueue.getJobCounts(
      'completed',
      'failed',
      'active',
      'waiting'
    );

    // Jobs should be completed or in progress
    expect(counts.completed + counts.active).toBeGreaterThan(0);
  });

  it('should prevent duplicate jobs with same jobId', async () => {
    await pushService.sendAlertBulk(mockAlert, [mockSubscriptions[0]]);
    await pushService.sendAlertBulk(mockAlert, [mockSubscriptions[0]]);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const jobs = await pushQueue.getJobs(['waiting', 'active']);
    const jobIds = jobs.map((j) => j.id);
    const uniqueJobIds = new Set(jobIds);

    // Should have only 1 unique job for the same alert+subscription
    expect(uniqueJobIds.size).toBe(1);
  });

  it('should handle expired subscriptions', async () => {
    const expiredSubscription: PushSubscription = {
      ...mockSubscriptions[0],
      id: 'sub-expired',
      expirationTime: Date.now() - 1000,
    };

    const result = await pushService.sendAlertBulk(mockAlert, [
      expiredSubscription,
      mockSubscriptions[1],
    ]);

    expect(result.queued).toBe(1); // Only non-expired
    expect(result.skipped).toBe(1);
  });

  it('should skip stale alerts', async () => {
    const staleAlert: PushAlert = {
      ...mockAlert,
      id: 'alert-stale',
      expiresAt: new Date(Date.now() - 5000),
    };

    const result = await pushService.sendAlertBulk(
      staleAlert,
      mockSubscriptions
    );

    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it('should track delivery metrics', async () => {
    const results = [
      {
        subscriptionId: 'sub-1',
        success: true,
        deliveryLatencyMs: 150,
      },
      {
        subscriptionId: 'sub-2',
        success: true,
        deliveryLatencyMs: 200,
      },
      {
        subscriptionId: 'sub-3',
        success: false,
        error: 'Timeout',
        deliveryLatencyMs: 3000,
      },
    ];

    const metrics = pushService.calculateMetrics(results);

    expect(metrics.totalSubscriptions).toBe(3);
    expect(metrics.successful).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.averageLatencyMs).toBeGreaterThan(0);
    expect(metrics.p95LatencyMs).toBeGreaterThan(0);
  });
});
