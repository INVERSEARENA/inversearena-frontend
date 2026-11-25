import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ProofStorageService } from '../src/services/proofStorageService';
import type { ProofBundle, DisputeEvidence } from '../src/types/proof';

describe('ProofStorageService', () => {
  let storage: ProofStorageService;

  const mockProofBundle: ProofBundle = {
    roundId: 'round-123',
    arenaId: 'arena-456',
    roundNumber: 5,
    bundleHash: '',
    generatedAt: new Date(),
    state: 'SETTLED',
    playerChoices: [
      {
        userId: 'user-1',
        choice: 'HIGH',
        stake: 100,
        timestamp: new Date(),
        choiceHash: 'hash1',
      },
    ],
    oracleYield: 5.2,
    randomSeed: 'seed123',
    resolution: {
      eliminatedPlayers: [],
      payouts: [{ userId: 'user-1', amount: 105, reason: 'WIN' }],
      poolBalances: { 'user-1': 105 },
    },
    merkleRoot: 'root123',
    merkleProofs: { 'user-1': ['proof1', 'proof2'] },
    timestamp: new Date(),
  };

  const mockDisputeEvidence: DisputeEvidence = {
    roundId: 'round-123',
    userId: 'user-1',
    evidenceHash: '',
    generatedAt: new Date(),
    playerChoice: mockProofBundle.playerChoices[0],
    wasEliminated: false,
    payout: mockProofBundle.resolution.payouts[0],
    merkleProof: ['proof1', 'proof2'],
    merkleRoot: 'root123',
    roundState: 'SETTLED',
    oracleYield: 5.2,
    totalPlayers: 1,
    eliminatedCount: 0,
  };

  beforeEach(() => {
    storage = new ProofStorageService();
  });

  describe('storeProofBundle', () => {
    it('should store proof bundle and return hash', async () => {
      const hash = await storage.storeProofBundle(mockProofBundle);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64); // SHA-256 hex
    });

    it('should be content-addressed (same data = same hash)', async () => {
      const hash1 = await storage.storeProofBundle(mockProofBundle);
      const hash2 = await storage.storeProofBundle(mockProofBundle);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hash for different data', async () => {
      const bundle2 = { ...mockProofBundle, roundNumber: 6 };

      const hash1 = await storage.storeProofBundle(mockProofBundle);
      const hash2 = await storage.storeProofBundle(bundle2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('getProofBundle', () => {
    it('should retrieve stored proof bundle', async () => {
      await storage.storeProofBundle(mockProofBundle);

      const retrieved = await storage.getProofBundle('round-123');

      expect(retrieved).toBeDefined();
      expect(retrieved?.roundId).toBe('round-123');
      expect(retrieved?.roundNumber).toBe(5);
    });

    it('should return null for non-existent bundle', async () => {
      const retrieved = await storage.getProofBundle('non-existent');

      expect(retrieved).toBeNull();
    });
  });

  describe('storeDisputeEvidence', () => {
    it('should store dispute evidence and return hash', async () => {
      const hash = await storage.storeDisputeEvidence(mockDisputeEvidence);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
    });

    it('should be content-addressed', async () => {
      const hash1 = await storage.storeDisputeEvidence(mockDisputeEvidence);
      const hash2 = await storage.storeDisputeEvidence(mockDisputeEvidence);

      expect(hash1).toBe(hash2);
    });
  });

  describe('getDisputeEvidence', () => {
    it('should retrieve stored dispute evidence', async () => {
      await storage.storeDisputeEvidence(mockDisputeEvidence);

      const retrieved = await storage.getDisputeEvidence('round-123', 'user-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.userId).toBe('user-1');
      expect(retrieved?.roundId).toBe('round-123');
    });

    it('should return null for non-existent evidence', async () => {
      const retrieved = await storage.getDisputeEvidence('non-existent', 'user-1');

      expect(retrieved).toBeNull();
    });
  });

  describe('hasProofBundle', () => {
    it('should return true for existing bundle', async () => {
      await storage.storeProofBundle(mockProofBundle);

      const exists = await storage.hasProofBundle('round-123');

      expect(exists).toBe(true);
    });

    it('should return false for non-existent bundle', async () => {
      const exists = await storage.hasProofBundle('non-existent');

      expect(exists).toBe(false);
    });
  });

  describe('invalidateRound', () => {
    it('should invalidate all artifacts for a round', async () => {
      await storage.storeProofBundle(mockProofBundle);
      await storage.storeDisputeEvidence(mockDisputeEvidence);

      await storage.invalidateRound('round-123');

      const bundle = await storage.getProofBundle('round-123');
      const evidence = await storage.getDisputeEvidence('round-123', 'user-1');

      expect(bundle).toBeNull();
      expect(evidence).toBeNull();
    });
  });

  describe('getStats', () => {
    it('should return storage statistics', async () => {
      await storage.storeProofBundle(mockProofBundle);
      await storage.storeDisputeEvidence(mockDisputeEvidence);

      const stats = await storage.getStats();

      expect(stats.totalArtifacts).toBeGreaterThan(0);
      expect(stats.bundleCount).toBe(1);
      expect(stats.evidenceCount).toBe(1);
      expect(stats.totalSize).toBeGreaterThan(0);
    });
  });
});
