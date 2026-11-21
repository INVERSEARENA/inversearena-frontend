/**
 * Web Push Notification Worker
 * 
 * Processes push notification jobs with:
 * - Configurable concurrency
 * - Automatic retries with exponential backoff
 * - Subscription pruning on invalid/expired subscriptions
 * - Delivery latency tracking
 */

import { Worker, type Job } from 'bullmq';
import type { PushJobData } from '../types/push';
import type { PushService } from '../services/pushService';
import { PUSH_QUEUE } from '../queues/pushQueue';
import { workerJobsPending } from '../utils/metrics';

export interface PushWorkerConfig {
  concurrency?: number;
  redisUrl?: string;
  onSubscriptionPrune?: (subscriptionId: string) => Promise<void>;
}

export function startPushWorker(
  pushService: PushService,
  config: PushWorkerConfig = {}
): Worker<PushJobData> {
  const {
    concurrency = 10, // Default: 10 concurrent push notifications
    redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379',
    onSubscriptionPrune,
  } = config;

  console.log(`[PushWorker] Starting with concurrency: ${concurrency}`);

  const worker = new Worker<PushJobData>(
    PUSH_QUEUE,
    async (job: Job<PushJobData>) => {
      const { alert, subscription, idempotencyKey, attemptNumber = 1 } = job.data;

      // Log processing start
      console.log(
        `[PushWorker] Processing job ${job.id}: alert=${alert.id}, subscription=${subscription.id}, attempt=${attemptNumber}`
      );

      // Check for duplicate (idempotency)
      // In a real implementation, you'd check a distributed cache/DB
      // For now, BullMQ's jobId prevents duplicates at queue level

      // Send push notification
      const result = await pushService.sendPushNotification(subscription, alert);

      // If subscription should be pruned, trigger cleanup
      if (result.shouldPrune && onSubscriptionPrune) {
        try {
          await onSubscriptionPrune(subscription.id);
          console.log(`[PushWorker] Pruned subscription ${subscription.id}`);
        } catch (error) {
          console.error(
            `[PushWorker] Failed to prune subscription ${subscription.id}:`,
            error
          );
        }
      }

      // If delivery failed and not a subscription issue, throw to trigger retry
      if (!result.success && !result.shouldPrune) {
        throw new Error(result.error || 'Push notification delivery failed');
      }

      return result;
    },
    {
      connection: { url: redisUrl },
      concurrency,
      limiter: {
        max: 100, // Max 100 jobs per duration
        duration: 1000, // per 1 second
      },
    }
  );

  // Track pending jobs
  worker.on('active', async () => {
    const counts = await worker.getJobCounts('active', 'waiting');
    workerJobsPending.set(
      { job_type: 'push' },
      counts.active + counts.waiting
    );
  });

  // Handle completed jobs
  worker.on('completed', (job: Job<PushJobData>) => {
    console.log(
      `[PushWorker] Completed job ${job.id}: alert=${job.data.alert.id}`
    );
  });

  // Handle failed jobs
  worker.on('failed', (job: Job<PushJobData> | undefined, err: Error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      console.error(
        `[PushWorker] Job ${job.id} failed after ${maxAttempts} attempts:`,
        err.message
      );
    } else {
      console.warn(
        `[PushWorker] Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}):`,
        err.message
      );
    }
  });

  // Handle errors
  worker.on('error', (err: Error) => {
    console.error('[PushWorker] Worker error:', err.message);
  });

  return worker;
}
