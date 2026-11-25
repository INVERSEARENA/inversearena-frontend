/**
 * Proof Bundle and Dispute Evidence Controller
 */

import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AsyncProofBundleService } from '../services/asyncProofBundleService';
import { AsyncProofEvidenceService } from '../services/asyncProofEvidenceService';
import { ProofStorageService } from '../services/proofStorageService';
import type { Queue } from 'bullmq';
import type { ProofGenerationJob } from '../types/proof';

export class ProofController {
  private bundleService: AsyncProofBundleService;
  private evidenceService: AsyncProofEvidenceService;
  private storage: ProofStorageService;

  constructor(
    private prisma: PrismaClient,
    private proofQueue?: Queue<ProofGenerationJob>
  ) {
    this.storage = new ProofStorageService();
    this.bundleService = new AsyncProofBundleService(prisma, this.storage);
    this.evidenceService = new AsyncProofEvidenceService(prisma, this.storage, this.bundleService);
  }

  /**
   * GET /api/rounds/:roundId/proof-bundle
   * 
   * Get proof bundle for a round (cached or generate)
   */
  async getProofBundle(req: Request, res: Response): Promise<void> {
    try {
      const { roundId } = req.params;

      const bundle = await this.bundleService.getOrGenerateProofBundle(roundId);

      // Set immutable cache headers for settled rounds
      if (bundle.state === 'SETTLED') {
        res.set({
          'Cache-Control': 'public, max-age=31536000, immutable',
          'ETag': bundle.bundleHash,
          'Content-Type': 'application/json',
        });
      }

      res.json({
        success: true,
        data: bundle,
      });
    } catch (error: any) {
      console.error('[ProofController] Error getting proof bundle:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * GET /api/rounds/:roundId/dispute-evidence/:userId
   * 
   * Get dispute evidence for a player (cached or generate)
   */
  async getDisputeEvidence(req: Request, res: Response): Promise<void> {
    try {
      const { roundId, userId } = req.params;

      const evidence = await this.evidenceService.getOrGenerateEvidence(
        roundId,
        userId
      );

      // Set immutable cache headers for settled rounds
      if (evidence.roundState === 'SETTLED') {
        res.set({
          'Cache-Control': 'public, max-age=31536000, immutable',
          'ETag': evidence.evidenceHash,
          'Content-Type': 'application/json',
        });
      }

      res.json({
        success: true,
        data: evidence,
      });
    } catch (error: any) {
      console.error('[ProofController] Error getting dispute evidence:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * POST /api/rounds/:roundId/generate-proofs
   * 
   * Trigger async proof generation (admin only)
   */
  async triggerProofGeneration(req: Request, res: Response): Promise<void> {
    try {
      const { roundId } = req.params;

      // Verify round exists
      const round = await this.prisma.round.findUnique({
        where: { id: roundId },
      });

      if (!round) {
        res.status(404).json({
          success: false,
          error: 'Round not found',
        });
        return;
      }

      if (!this.proofQueue) {
        // Fallback: generate synchronously
        const bundle = await this.bundleService.generateProofBundle(roundId);
        const evidenceHashes = await this.evidenceService.generateAllEvidence(roundId);

        res.json({
          success: true,
          message: 'Proofs generated synchronously',
          data: {
            bundleHash: bundle.bundleHash,
            evidenceCount: Object.keys(evidenceHashes).length,
          },
        });
        return;
      }

      // Queue async generation
      const job = await this.proofQueue.add('generate-proofs', {
        roundId,
        arenaId: round.arenaId,
        roundNumber: round.roundNumber,
        trigger: 'manual',
        requestedAt: new Date(),
      });

      res.json({
        success: true,
        message: 'Proof generation queued',
        data: {
          jobId: job.id,
          roundId,
        },
      });
    } catch (error: any) {
      console.error('[ProofController] Error triggering proof generation:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * DELETE /api/rounds/:roundId/proofs
   * 
   * Invalidate proofs for a round (for reorg/correction)
   */
  async invalidateProofs(req: Request, res: Response): Promise<void> {
    try {
      const { roundId } = req.params;

      await this.storage.invalidateRound(roundId);

      res.json({
        success: true,
        message: `Proofs invalidated for round ${roundId}`,
      });
    } catch (error: any) {
      console.error('[ProofController] Error invalidating proofs:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * GET /api/proof-stats
   * 
   * Get storage statistics
   */
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.storage.getStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      console.error('[ProofController] Error getting stats:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
}
