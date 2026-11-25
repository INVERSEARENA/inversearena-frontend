import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { PushService } from '../src/services/pushService';
import type { PushAlert, PushSubscription } from '../src/types/push';

// Mock web-push
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

describe('PushService', () => {
  let pushService: PushService;
  
  const mockSubscription: PushSubscription = {
    id: 'sub-123',
    userId: 'user-456',
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: {
      p256dh: 'test-p256dh-key',
      auth: 'test-auth-key',
    },
    createdAt: new Date(),
  };

  const mockAlert: PushAlert = {
    id: 'alert-789',
    type: 'round_start',
    title: 'Round Starting!',
    body: 'A new round is about to begin',
    urgency: 'high',
    ttl: 3600,
    createdAt: new Date(),
  };

  beforeEach(() => {
    pushService = new PushService();
    jest.clearAllMocks();
  });

  describe('sendPushNotification', () => {
    it('should send push notification successfully', async () => {
      const webpush = require('web-push');
      webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

      const result = await pushService.sendPushNotification(
        mockSubscription,
        mockAlert
      );

      expect(result.success).toBe(true);
      expect(result.subscriptionId).toBe('sub-123');
      expect(result.statusCode).toBe(201);
      expect(result.deliveryLatencyMs).toBeGreaterThan(0);
      expect(webpush.sendNotification).toHaveBeenCalled();
    });

    it('should handle expired alert', async () => {
      const expiredAlert: PushAlert = {
        ...mockAlert,
        expiresAt: new Date(Date.now() - 10000), // 10 seconds ago
      };

      const result = await pushService.sendPushNotification(
        mockSubscription,
        expiredAlert
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Alert expired');
    });

    it('should mark subscription for pruning on 410 Gone', async () => {
      const webpush = require('web-push');
      const error = new Error('Gone');
      (error as any).statusCode = 410;
      webpush.sendNotification.mockRejectedValue(error);

      const result = await pushService.sendPushNotification(
        mockSubscription,
        mockAlert
      );

      expect(result.success).toBe(false);
      expect(result.shouldPrune).toBe(true);
    });

    it('should mark subscription for pruning on 404 Not Found', async () => {
      const webpush = require('web-push');
      const error = new Error('Not Found');
      (error as any).statusCode = 404;
      webpush.sendNotification.mockRejectedValue(error);

      const result = await pushService.sendPushNotification(
        mockSubscription,
        mockAlert
      );

      expect(result.success).toBe(false);
      expect(result.shouldPrune).toBe(true);
    });

    it('should not prune subscription on temporary failure', async () => {
      const webpush = require('web-push');
      const error = new Error('Service Unavailable');
      (error as any).statusCode = 503;
      webpush.sendNotification.mockRejectedValue(error);

      const result = await pushService.sendPushNotification(
        mockSubscription,
        mockAlert
      );

      expect(result.success).toBe(false);
      expect(result.shouldPrune).toBe(false);
    });

    it('should include payload with correct structure', async () => {
      const webpush = require('web-push');
      webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

      await pushService.sendPushNotification(mockSubscription, mockAlert);

      const call = webpush.sendNotification.mock.calls[0];
      const payload = JSON.parse(call[1]);

      expect(payload.title).toBe('Round Starting!');
      expect(payload.body).toBe('A new round is about to begin');
      expect(payload.data.alertId).toBe('alert-789');
      expect(payload.data.type).toBe('round_start');
      expect(payload.timestamp).toBeDefined();
    });
  });

  describe('sendAlertBulk', () => {
    it('should filter out expired subscriptions', async () => {
      const subscriptions: PushSubscription[] = [
        mockSubscription,
        {
          ...mockSubscription,
          id: 'sub-expired',
          expirationTime: Date.now() - 1000, // Expired
        },
        {
          ...mockSubscription,
          id: 'sub-valid',
          expirationTime: Date.now() + 10000, // Valid
        },
      ];

      const result = await pushService.sendAlertBulk(mockAlert, subscriptions);

      // Without queue, falls back to sequential
      expect(result.skipped).toBeGreaterThan(0);
    });

    it('should skip stale alerts', async () => {
      const staleAlert: PushAlert = {
        ...mockAlert,
        expiresAt: new Date(Date.now() - 5000), // 5 seconds ago
      };

      const result = await pushService.sendAlertBulk(staleAlert, [
        mockSubscription,
      ]);

      expect(result.queued).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('calculateMetrics', () => {
    it('should calculate delivery metrics correctly', () => {
      const results = [
        {
          subscriptionId: 'sub-1',
          success: true,
          deliveryLatencyMs: 100,
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
          deliveryLatencyMs: 5000,
        },
        {
          subscriptionId: 'sub-4',
          success: false,
          shouldPrune: true,
          deliveryLatencyMs: 50,
        },
      ];

      const metrics = pushService.calculateMetrics(results);

      expect(metrics.totalSubscriptions).toBe(4);
      expect(metrics.successful).toBe(2);
      expect(metrics.failed).toBe(2);
      expect(metrics.pruned).toBe(1);
      expect(metrics.averageLatencyMs).toBeGreaterThan(0);
      expect(metrics.p95LatencyMs).toBeGreaterThan(0);
    });

    it('should handle empty results', () => {
      const metrics = pushService.calculateMetrics([]);

      expect(metrics.totalSubscriptions).toBe(0);
      expect(metrics.successful).toBe(0);
      expect(metrics.failed).toBe(0);
      expect(metrics.pruned).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
    });
  });

  describe('rate limiting', () => {
    it('should allow requests within rate limit', async () => {
      const webpush = require('web-push');
      webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

      // Send 5 notifications rapidly (well under limit)
      for (let i = 0; i < 5; i++) {
        const result = await pushService.sendPushNotification(
          mockSubscription,
          mockAlert
        );
        expect(result.success).toBe(true);
      }
    });
  });
});
