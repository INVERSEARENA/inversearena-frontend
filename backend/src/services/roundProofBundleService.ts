/**
 * Round Proof Bundle Service
 * 
 * Generates verifiable proof bundles for settled rounds
 * Includes Merkle proofs for player verification
 */

import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { ProofBundle, PlayerChoiceProof, PayoutProof } from '../types/proof';
import { ProofStorageService } from './proofStorageService';

export class RoundProofBundleService {
  private storage: ProofStorageService;

  constructor(
    private prisma: PrismaClient,
    storage?: ProofStorageService
  ) {
    this.storage = storage || new ProofStorageService();
  }

  /**
   * Generate proof bundle for a round
   * 
   * This performs RPC/DB reads and hashing to create a verifiable artifact
   */
  async generateProofBundle(roundId: string): Promise<ProofBundle> {
    console.log(`[ProofBundle] Generating proof bundle for round ${roundId}`);
    const startTime = Date.now();

    // Fetch round data from database
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      include: {
        arena: true,
        eliminationLogs: {
          include: { user: true },
        },
      },
    });

    if (!round) {
      throw new Error(`Round ${roundId} not found`);
    }

    if (round.state !== 'SETTLED' && round.state !== 'RESOLVED') {
      throw new Error(`Round ${roundId} not settled (state: ${round.state})`);
    }

    const metadata = round.metadata as any;
    
    // Build player choice proofs
    const playerChoiceProofs: PlayerChoiceProof[] = (metadata.playerChoices || []).map(
      (pc: any) => ({
        userId: pc.userId,
        choice: pc.choice,
        stake: pc.stake,
        timestamp: new Date(pc.timestamp || round.createdAt),
        choiceHash: this.hashChoice(pc.userId, pc.choice, pc.stake),
      })
    );

    // Build payout proofs
    const payoutProofs: PayoutProof[] = (metadata.resolution?.payouts || []).map(
      (p: any) => ({
        userId: p.userId,
        amount: p.amount,
        reason: 'WIN' as const,
        transactionHash: p.transactionHash,
      })
    );

    // Build Merkle tree for verification
    const { merkleRoot, merkleProofs } = this.buildMerkleTree(playerChoiceProofs);

    // Create proof bundle
    const bundle: ProofBundle = {
      roundId: round.id,
      arenaId: round.arenaId,
      roundNumber: round.roundNumber,
      bundleHash: '', // Will be set by storage service
      generatedAt: new Date(),
      state: round.state,
      playerChoices: playerChoiceProofs,
      oracleYield: metadata.oracleYield || 0,
      randomSeed: metadata.randomSeed || '',
      resolution: {
        eliminatedPlayers: metadata.resolution?.eliminatedPlayers || [],
        payouts: payoutProofs,
        poolBalances: metadata.resolution?.poolBalances || {},
      },
      merkleRoot,
      merkleProofs,
      blockHeight: metadata.blockHeight,
      timestamp: round.updatedAt,
    };

    // Store bundle with content-addressed hash
    const bundleHash = await this.storage.storeProofBundle(bundle);
    bundle.bundleHash = bundleHash;

    const duration = Date.now() - startTime;
    console.log(
      `[ProofBundle] Generated bundle ${bundleHash} for round ${roundId} in ${duration}ms`
    );

    return bundle;
  }

  /**
   * Get cached proof bundle or generate if missing
   */
  async getOrGenerateProofBundle(roundId: string): Promise<ProofBundle> {
    // Check cache first
    const cached = await this.storage.getProofBundle(roundId);
    if (cached) {
      console.log(`[ProofBundle] Serving cached bundle for round ${roundId}`);
      return cached;
    }

    // Generate on-demand if missing
    console.log(`[ProofBundle] Cache miss, generating bundle for round ${roundId}`);
    return await this.generateProofBundle(roundId);
  }

  /**
   * Check if proof bundle exists
   */
  async hasProofBundle(roundId: string): Promise<boolean> {
    return await this.storage.hasProofBundle(roundId);
  }

  /**
   * Hash a player choice for verification
   */
  private hashChoice(userId: string, choice: string, stake: number): string {
    const data = `${userId}:${choice}:${stake}`;
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Build Merkle tree for player choices
   * 
   * Provides cryptographic proof that a player's choice was included
   */
  private buildMerkleTree(choices: PlayerChoiceProof[]): {
    merkleRoot: string;
    merkleProofs: Record<string, string[]>;
  } {
    if (choices.length === 0) {
      return { merkleRoot: '', merkleProofs: {} };
    }

    // Create leaf nodes (hashes of player choices)
    const leaves = choices.map((c) => c.choiceHash);
    const merkleProofs: Record<string, string[]> = {};

    // Build tree bottom-up
    let currentLevel = leaves;
    const tree: string[][] = [currentLevel];

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        const parent = createHash('sha256')
          .update(left + right)
          .digest('hex');
        nextLevel.push(parent);
      }

      tree.push(nextLevel);
      currentLevel = nextLevel;
    }

    const merkleRoot = currentLevel[0];

    // Generate proofs for each player
    choices.forEach((choice, index) => {
      const proof: string[] = [];
      let currentIndex = index;

      for (let level = 0; level < tree.length - 1; level++) {
        const isRightNode = currentIndex % 2 === 1;
        const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

        if (siblingIndex < tree[level].length) {
          proof.push(tree[level][siblingIndex]);
        }

        currentIndex = Math.floor(currentIndex / 2);
      }

      merkleProofs[choice.userId] = proof;
    });

    return { merkleRoot, merkleProofs };
  }
}
