/**
 * Async Proof Evidence Service (#1775)
 * 
 * Generates player-specific dispute evidence for rounds with caching
 * Scoped to individual players for privacy
 * 
 * Note: This is distinct from DisputeEvidenceService which handles real-time evidence packages.
 * This service focuses on async generation with content-addressed storage.
 */

import { PrismaClient } from '@prisma/client';
import type { DisputeEvidence, PlayerChoiceProof, PayoutProof } from '../types/proof';
import { ProofStorageService } from './proofStorageService';
import { AsyncProofBundleService } from './asyncProofBundleService';

export class AsyncProofEvidenceService {
  private storage: ProofStorageService;
  private bundleService: AsyncProofBundleService;

  constructor(
    private prisma: PrismaClient,
    storage?: ProofStorageService,
    bundleService?: AsyncProofBundleService
  ) {
    this.storage = storage || new ProofStorageService();
    this.bundleService = bundleService || new AsyncProofBundleService(prisma, this.storage);
  }

  /**
   * Generate dispute evidence for a specific player
   */
  async generateDisputeEvidence(
    roundId: string,
    userId: string
  ): Promise<DisputeEvidence> {
    console.log(
      `[AsyncProofEvidence] Generating evidence for user ${userId} in round ${roundId}`
    );
    const startTime = Date.now();

    // Get proof bundle (generates if missing)
    const bundle = await this.bundleService.getOrGenerateProofBundle(roundId);

    // Find player's data
    const playerChoice = bundle.playerChoices.find((pc) => pc.userId === userId);
    if (!playerChoice) {
      throw new Error(`Player ${userId} not found in round ${roundId}`);
    }

    const wasEliminated = bundle.resolution.eliminatedPlayers.includes(userId);
    const payout = bundle.resolution.payouts.find((p) => p.userId === userId);
    const merkleProof = bundle.merkleProofs[userId] || [];

    // Create scoped evidence
    const evidence: DisputeEvidence = {
      roundId,
      userId,
      evidenceHash: '', // Will be set by storage service
      generatedAt: new Date(),
      playerChoice,
      wasEliminated,
      payout,
      merkleProof,
      merkleRoot: bundle.merkleRoot,
      roundState: bundle.state,
      oracleYield: bundle.oracleYield,
      totalPlayers: bundle.playerChoices.length,
      eliminatedCount: bundle.resolution.eliminatedPlayers.length,
    };

    // Store evidence with content-addressed hash
    const evidenceHash = await this.storage.storeDisputeEvidence(evidence);
    evidence.evidenceHash = evidenceHash;

    const duration = Date.now() - startTime;
    console.log(
      `[AsyncProofEvidence] Generated evidence ${evidenceHash} for user ${userId} in ${duration}ms`
    );

    return evidence;
  }

  /**
   * Get cached evidence or generate if missing
   */
  async getOrGenerateEvidence(
    roundId: string,
    userId: string
  ): Promise<DisputeEvidence> {
    // Check cache first
    const cached = await this.storage.getDisputeEvidence(roundId, userId);
    if (cached) {
      console.log(
        `[AsyncProofEvidence] Serving cached evidence for user ${userId} in round ${roundId}`
      );
      return cached;
    }

    // Generate on-demand if missing
    console.log(
      `[AsyncProofEvidence] Cache miss, generating evidence for user ${userId} in round ${roundId}`
    );
    return await this.generateDisputeEvidence(roundId, userId);
  }

  /**
   * Generate evidence for all players in a round (batch)
   */
  async generateAllEvidence(roundId: string): Promise<Record<string, string>> {
    console.log(`[AsyncProofEvidence] Generating evidence for all players in round ${roundId}`);

    const bundle = await this.bundleService.getOrGenerateProofBundle(roundId);
    const evidenceHashes: Record<string, string> = {};

    for (const playerChoice of bundle.playerChoices) {
      const evidence = await this.generateDisputeEvidence(roundId, playerChoice.userId);
      evidenceHashes[playerChoice.userId] = evidence.evidenceHash;
    }

    console.log(
      `[AsyncProofEvidence] Generated ${Object.keys(evidenceHashes).length} evidence artifacts`
    );

    return evidenceHashes;
  }

  /**
   * Verify evidence integrity
   */
  verifyEvidence(evidence: DisputeEvidence): boolean {
    // In production, this would verify:
    // 1. Merkle proof against root
    // 2. Signature verification
    // 3. Hash consistency

    // Simplified verification
    return (
      evidence.merkleProof.length > 0 &&
      evidence.merkleRoot.length > 0 &&
      evidence.playerChoice.choiceHash.length > 0
    );
  }
}
