/**
 * Tests for Mock Data Factory
 * 
 * Demonstrates factory usage and validates core functionality
 */

import {
  createMockArena,
  createMockParticipant,
  createMockRoundResult,
  createMockYieldSnapshot,
  createMockEliminationLog,
} from './mockFactory';

describe('Mock Data Factory', () => {
  describe('createMockParticipant', () => {
    it('should generate a participant with valid Stellar address format', () => {
      const participant = createMockParticipant();
      
      expect(participant.wallet).toMatch(/^G[A-Z2-7]{55}$/);
      expect(participant.status).toMatch(/^(JOINING|READY|ALIVE|ELIMINATED)$/);
      expect(typeof participant.joinedAt).toBe('number');
      expect(typeof participant.currentRound).toBe('number');
    });

    it('should produce deterministic results with same seed', () => {
      const participant1 = createMockParticipant({}, { seed: 12345 });
      const participant2 = createMockParticipant({}, { seed: 12345 });
      
      expect(participant1).toEqual(participant2);
    });

    it('should respect overrides', () => {
      const participant = createMockParticipant({
        status: 'ELIMINATED',
        currentRound: 5,
      });
      
      expect(participant.status).toBe('ELIMINATED');
      expect(participant.currentRound).toBe(5);
    });
  });

  describe('createMockRoundResult', () => {
    it('should generate a valid round result', () => {
      const round = createMockRoundResult();
      
      expect(typeof round.round).toBe('number');
      expect(['HEADS', 'TAILS', null]).toContain(round.choice);
      expect(['HEADS', 'TAILS']).toContain(round.outcome);
      expect(['HEADS', 'TAILS']).toContain(round.majorityChoice);
      expect(typeof round.eliminatedCount).toBe('number');
      expect(round.eliminatedCount).toBeGreaterThanOrEqual(0);
    });

    it('should produce deterministic results with same seed', () => {
      const round1 = createMockRoundResult({}, { seed: 99999 });
      const round2 = createMockRoundResult({}, { seed: 99999 });
      
      expect(round1).toEqual(round2);
    });
  });

  describe('createMockYieldSnapshot', () => {
    it('should generate realistic yield data', () => {
      const yieldData = createMockYieldSnapshot();
      
      expect(yieldData.principal).toBeGreaterThan(0);
      expect(yieldData.accruedYield).toBeGreaterThanOrEqual(0);
      expect(yieldData.apy).toBeGreaterThanOrEqual(0);
      expect(yieldData.apy).toBeLessThanOrEqual(100);
      expect(yieldData.surgeMultiplier).toBeGreaterThanOrEqual(1.0);
      expect(typeof yieldData.lastUpdatedAt).toBe('number');
    });

    it('should respect overrides', () => {
      const yieldData = createMockYieldSnapshot({
        apy: 12.5,
        principal: 5000,
      });
      
      expect(yieldData.apy).toBe(12.5);
      expect(yieldData.principal).toBe(5000);
    });
  });

  describe('createMockEliminationLog', () => {
    it('should generate exact count of events', () => {
      const events = createMockEliminationLog(5);
      
      expect(events).toHaveLength(5);
    });

    it('should generate sequential round numbers', () => {
      const events = createMockEliminationLog(10);
      
      events.forEach((event, index) => {
        expect(event.round).toBe(index + 1);
      });
    });

    it('should generate valid elimination reasons', () => {
      const events = createMockEliminationLog(20);
      
      events.forEach(event => {
        expect(['MINORITY', 'TIMEOUT', 'FORFEIT']).toContain(event.reason);
      });
    });

    it('should generate unique wallet addresses', () => {
      const events = createMockEliminationLog(10);
      const wallets = events.map(e => e.walletAddress);
      const uniqueWallets = new Set(wallets);
      
      expect(uniqueWallets.size).toBe(wallets.length);
    });

    it('should throw error for invalid count', () => {
      expect(() => createMockEliminationLog(-1)).toThrow(TypeError);
      expect(() => createMockEliminationLog(1.5)).toThrow(TypeError);
    });

    it('should produce deterministic results with same seed', () => {
      const events1 = createMockEliminationLog(5, { seed: 777 });
      const events2 = createMockEliminationLog(5, { seed: 777 });
      
      expect(events1).toEqual(events2);
    });
  });

  describe('createMockArena', () => {
    it('should generate a complete arena object', () => {
      const arena = createMockArena();
      
      expect(typeof arena.arenaId).toBe('string');
      expect(['PENDING', 'JOINING', 'ACTIVE', 'RESOLVING', 'ENDED', 'CANCELLED']).toContain(arena.status);
      expect(typeof arena.maxPlayers).toBe('number');
      expect(typeof arena.currentPlayers).toBe('number');
      expect(typeof arena.entryFee).toBe('string');
      expect(typeof arena.currentRound).toBe('number');
      expect(['WAITING', 'CHOOSING', 'RESOLVING', 'RESOLVED']).toContain(arena.roundPhase);
      expect(typeof arena.createdAt).toBe('number');
      expect(Array.isArray(arena.participants)).toBe(true);
      expect(Array.isArray(arena.rounds)).toBe(true);
      expect(arena.yieldData).toBeDefined();
    });

    it('should produce deterministic results with same seed', () => {
      const arena1 = createMockArena({}, { seed: 54321 });
      const arena2 = createMockArena({}, { seed: 54321 });
      
      expect(arena1).toEqual(arena2);
    });

    it('should respect overrides', () => {
      const customParticipants = [
        createMockParticipant({ status: 'ALIVE' }),
        createMockParticipant({ status: 'ALIVE' }),
      ];
      
      const arena = createMockArena({
        status: 'ACTIVE',
        maxPlayers: 50,
        participants: customParticipants,
      });
      
      expect(arena.status).toBe('ACTIVE');
      expect(arena.maxPlayers).toBe(50);
      expect(arena.participants).toEqual(customParticipants);
    });
  });
});
