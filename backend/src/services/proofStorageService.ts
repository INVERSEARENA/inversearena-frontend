/**
 * Content-Addressed Proof Artifact Storage
 * 
 * Stores proof bundles and dispute evidence with content-addressed hashing
 * Supports both in-memory and Redis storage
 */

import { createHash } from 'crypto';
import { cache } from '../cache/cacheService';
import type { ProofArtifact, ProofBundle, DisputeEvidence } from '../types/proof';

export class ProofStorageService {
  private readonly PROOF_PREFIX = 'proof:artifact:';
  private readonly INDEX_PREFIX = 'proof:index:';
  private readonly DEFAULT_TTL = 30 * 24 * 60 * 60; // 30 days for settled rounds
  
  // In-memory fallback for testing/no-Redis environments
  private memoryStorage = new Map<string, ProofArtifact>();

  /**
   * Store proof bundle with content-addressed hash
   */
  async storeProofBundle(bundle: ProofBundle): Promise<string> {
    const hash = this.computeHash(bundle);
    
    const artifact: ProofArtifact = {
      hash,
      type: 'proof_bundle',
      roundId: bundle.roundId,
      data: bundle,
      size: JSON.stringify(bundle).length,
      createdAt: new Date(),
    };

    await this.storeArtifact(artifact);
    await this.indexArtifact(bundle.roundId, hash, 'bundle');
    
    return hash;
  }

  /**
   * Store dispute evidence with content-addressed hash
   */
  async storeDisputeEvidence(evidence: DisputeEvidence): Promise<string> {
    const hash = this.computeHash(evidence);
    
    const artifact: ProofArtifact = {
      hash,
      type: 'dispute_evidence',
      roundId: evidence.roundId,
      userId: evidence.userId,
      data: evidence,
      size: JSON.stringify(evidence).length,
      createdAt: new Date(),
    };

    await this.storeArtifact(artifact);
    await this.indexArtifact(
      evidence.roundId,
      hash,
      'evidence',
      evidence.userId
    );
    
    return hash;
  }

  /**
   * Retrieve artifact by hash
   */
  async getArtifact(hash: string): Promise<ProofArtifact | null> {
    try {
      const key = `${this.PROOF_PREFIX}${hash}`;
      const cached = await cache.get<ProofArtifact>(key);
      
      if (cached) {
        return cached;
      }

      // Fallback to memory storage
      return this.memoryStorage.get(hash) || null;
    } catch (error) {
      console.error('[ProofStorage] Error retrieving artifact:', error);
      return this.memoryStorage.get(hash) || null;
    }
  }

  /**
   * Get proof bundle for round
   */
  async getProofBundle(roundId: string): Promise<ProofBundle | null> {
    const hash = await this.getIndexedHash(roundId, 'bundle');
    if (!hash) return null;

    const artifact = await this.getArtifact(hash);
    return artifact?.type === 'proof_bundle' 
      ? (artifact.data as ProofBundle) 
      : null;
  }

  /**
   * Get dispute evidence for user in round
   */
  async getDisputeEvidence(
    roundId: string,
    userId: string
  ): Promise<DisputeEvidence | null> {
    const hash = await this.getIndexedHash(roundId, 'evidence', userId);
    if (!hash) return null;

    const artifact = await this.getArtifact(hash);
    return artifact?.type === 'dispute_evidence' 
      ? (artifact.data as DisputeEvidence) 
      : null;
  }

  /**
   * Check if proof bundle exists for round
   */
  async hasProofBundle(roundId: string): Promise<boolean> {
    const hash = await this.getIndexedHash(roundId, 'bundle');
    return hash !== null;
  }

  /**
   * Invalidate all artifacts for a round (for reorg/correction)
   */
  async invalidateRound(roundId: string): Promise<void> {
    try {
      // Delete index entries
      await cache.delByPattern(`${this.INDEX_PREFIX}${roundId}:*`);
      
      // Note: artifacts remain in storage (content-addressed)
      // but are no longer indexed, so won't be found
      console.log(`[ProofStorage] Invalidated artifacts for round ${roundId}`);
    } catch (error) {
      console.error('[ProofStorage] Error invalidating round:', error);
    }
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    totalArtifacts: number;
    totalSize: number;
    bundleCount: number;
    evidenceCount: number;
  }> {
    // In production, this would query storage backend
    // For now, return memory storage stats
    let totalSize = 0;
    let bundleCount = 0;
    let evidenceCount = 0;

    for (const artifact of this.memoryStorage.values()) {
      totalSize += artifact.size;
      if (artifact.type === 'proof_bundle') bundleCount++;
      if (artifact.type === 'dispute_evidence') evidenceCount++;
    }

    return {
      totalArtifacts: this.memoryStorage.size,
      totalSize,
      bundleCount,
      evidenceCount,
    };
  }

  /**
   * Compute content-addressed hash
   */
  private computeHash(data: ProofBundle | DisputeEvidence): string {
    const json = JSON.stringify(data, Object.keys(data).sort());
    return createHash('sha256').update(json).digest('hex');
  }

  /**
   * Store artifact in cache/storage
   */
  private async storeArtifact(artifact: ProofArtifact): Promise<void> {
    const key = `${this.PROOF_PREFIX}${artifact.hash}`;
    
    try {
      // Store in Redis with long TTL for settled rounds
      await cache.set(key, artifact, this.DEFAULT_TTL);
    } catch (error) {
      console.warn('[ProofStorage] Redis unavailable, using memory storage');
    }

    // Always store in memory as fallback
    this.memoryStorage.set(artifact.hash, artifact);
  }

  /**
   * Index artifact for quick lookup
   */
  private async indexArtifact(
    roundId: string,
    hash: string,
    type: 'bundle' | 'evidence',
    userId?: string
  ): Promise<void> {
    const indexKey = userId
      ? `${this.INDEX_PREFIX}${roundId}:${type}:${userId}`
      : `${this.INDEX_PREFIX}${roundId}:${type}`;

    try {
      await cache.set(indexKey, hash, this.DEFAULT_TTL);
    } catch (error) {
      console.warn('[ProofStorage] Failed to index artifact');
    }
  }

  /**
   * Get indexed hash
   */
  private async getIndexedHash(
    roundId: string,
    type: 'bundle' | 'evidence',
    userId?: string
  ): Promise<string | null> {
    const indexKey = userId
      ? `${this.INDEX_PREFIX}${roundId}:${type}:${userId}`
      : `${this.INDEX_PREFIX}${roundId}:${type}`;

    try {
      return await cache.get<string>(indexKey);
    } catch (error) {
      return null;
    }
  }
}
