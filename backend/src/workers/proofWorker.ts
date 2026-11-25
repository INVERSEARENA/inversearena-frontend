/**
 * Proof Generation Worker
 * 
 * Processes proof bundle generation jobs asynchronously
 * Triggered by round settlement events
 */

import { Worker, type Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { ProofGenerationJob, ProofGenerationResult } from '../types/proof';
import { AsyncProofBundleService } from '../services/asyncProofBundleService';
import { AsyncProofEvidenceService } from '../services/asyncProofEvidenceService';
import { ProofStorageService } from '../services/proofStorageService';
import { PROOF_QUEUE } from '../queues/proofQueue';
import { workerJobsPending } from '../utils/metrics';

export interface ProofWorkerConfig {
  concurrency?: number;
  redisUrl?: string;
}

export function startProofWorker(
  prisma: PrismaClient,
  config: ProofWorkerConfig = {}
): Worker<ProofGenerationJob> {
  const {
    concurrency = 2, // Low concurrency for CPU-intensive hashing
    redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379',
  } = config;

  const storage = new ProofStorageService();
  const bundleService = new AsyncProofBundleService(prisma, storage);
  const evidenceService = new AsyncProofEvidenceService(prisma, storage, bundleService);

  console.log(`[ProofWorker] Starting with concurrency: ${concurrency}`);

  const worker = new Worker<ProofGenerationJob>(
    PROOF_QUEUE,
    async (job: Job<ProofGenerationJob>): Promise<ProofGenerationResult> => {
      const { roundId, arenaId, roundNumber, trigger } = job.data;

      console.log(
        `[ProofWorker] Processing job ${job.id}: round=${roundId}, trigger=${trigger}`
      );

      const startTime = Date.now();

      try {
        // Generate proof bundle
        const bundle = await bundleService.generateProofBundle(roundId);

        // Generate evidence for all players
        const evidenceHashes = await evidenceService.generateAllEvidence(roundId);

        // Get storage stats
        const stats = await storage.getStats();

        const generationTimeMs = Date.now() - startTime;

        const result: ProofGenerationResult = {
          roundId,
          bundleHash: bundle.bundleHash,
          evidenceHashes,
          generationTimeMs,
          artifactCount: 1 + Object.keys(evidenceHashes).length,
          totalSize: stats.totalSize,
        };

        console.log(
          `[ProofWorker] Completed job ${job.id}: ` +
            `generated ${result.artifactCount} artifacts in ${generationTimeMs}ms`
        );

        return result;
      } catch (error: any) {
        console.error(`[ProofWorker] Job ${job.id} failed:`, error.message);
        throw error;
      }
    },
    {
      connection: { url: redisUrl },
      concurrency,
    }
  );

  // Track pending jobs
  worker.on('active', async () => {
    const counts = await worker.getJobCounts('active', 'waiting');
    workerJobsPending.set(
      { job_type: 'proof' },
      counts.active + counts.waiting
    );
  });

  // Handle completed jobs
  worker.on('completed', (job: Job<ProofGenerationJob>, result: ProofGenerationResult) => {
    console.log(
      `[ProofWorker] Job ${job.id} completed: ` +
        `${result.artifactCount} artifacts, ${result.generationTimeMs}ms`
    );
  });

  // Handle failed jobs
  worker.on('failed', (job: Job<ProofGenerationJob> | undefined, err: Error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      console.error(
        `[ProofWorker] Job ${job.id} failed permanently after ${maxAttempts} attempts:`,
        err.message
      );
    } else {
      console.warn(
        `[ProofWorker] Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}):`,
        err.message
      );
    }
  });

  // Handle errors
  worker.on('error', (err: Error) => {
    console.error('[ProofWorker] Worker error:', err.message);
  });

  return worker;
}
