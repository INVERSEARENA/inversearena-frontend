import { Queue } from 'bullmq';
import type { ProofGenerationJob } from '../types/proof';

export const PROOF_QUEUE = 'proof-generation';

function redisConnectionOpts() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  return { url };
}

export function createProofQueue(): Queue<ProofGenerationJob> {
  return new Queue<ProofGenerationJob>(PROOF_QUEUE, {
    connection: redisConnectionOpts(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 }, // 5s, 10s, 20s
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}
