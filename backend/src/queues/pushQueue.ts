import { Queue } from 'bullmq';
import type { PushJobData } from '../types/push';

export const PUSH_QUEUE = 'web-push';

function redisConnectionOpts() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  return { url };
}

export function createPushQueue(): Queue<PushJobData> {
  return new Queue<PushJobData>(PUSH_QUEUE, {
    connection: redisConnectionOpts(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 }, // 1s, 2s, 4s
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}
