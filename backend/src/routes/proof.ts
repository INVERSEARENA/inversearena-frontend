import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { ProofController } from '../controllers/proof.controller';
import type { Queue } from 'bullmq';
import type { ProofGenerationJob } from '../types/proof';

export function createProofRouter(
  prisma: PrismaClient,
  proofQueue?: Queue<ProofGenerationJob>
): Router {
  const router = Router();
  const controller = new ProofController(prisma, proofQueue);

  // Get proof bundle for round
  router.get(
    '/rounds/:roundId/proof-bundle',
    (req, res) => controller.getProofBundle(req, res)
  );

  // Get dispute evidence for player
  router.get(
    '/rounds/:roundId/dispute-evidence/:userId',
    (req, res) => controller.getDisputeEvidence(req, res)
  );

  // Trigger proof generation (admin only - add auth middleware in production)
  router.post(
    '/rounds/:roundId/generate-proofs',
    (req, res) => controller.triggerProofGeneration(req, res)
  );

  // Invalidate proofs (admin only - add auth middleware in production)
  router.delete(
    '/rounds/:roundId/proofs',
    (req, res) => controller.invalidateProofs(req, res)
  );

  // Get storage stats
  router.get(
    '/proof-stats',
    (req, res) => controller.getStats(req, res)
  );

  return router;
}
