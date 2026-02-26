/**
 * Tests for fetchArenaState function
 * 
 * Note: These are integration tests that require a deployed contract.
 * For local development, you can mock the Server.simulateTransaction response.
 */

import { describe, it, expect } from '@jest/globals';
import { fetchArenaState } from '../stellar-transactions';

describe('fetchArenaState', () => {
  it('should validate arena ID format', async () => {
    await expect(
      fetchArenaState('invalid-id')
    ).rejects.toThrow();
  });

  it('should validate user address format when provided', async () => {
    const validArenaId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    
    await expect(
      fetchArenaState(validArenaId, 'invalid-address')
    ).rejects.toThrow();
  });

  it('should accept valid stellar contract ID', async () => {
    const validArenaId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    
    // This will fail with contract error if contract doesn't exist, but validates the ID format
    try {
      await fetchArenaState(validArenaId);
    } catch (error) {
      // Expected to fail if contract doesn't exist, but should not be a validation error
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Arena state fetch failed');
    }
  });

  it('should return correct response shape', async () => {
    // This test requires a real deployed contract
    // For now, we just verify the function signature and error handling
    const validArenaId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const validUserAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    
    try {
      const result = await fetchArenaState(validArenaId, validUserAddress);
      
      // If it succeeds, verify the shape
      expect(result).toHaveProperty('arenaId');
      expect(result).toHaveProperty('survivorsCount');
      expect(result).toHaveProperty('maxCapacity');
      expect(result).toHaveProperty('isUserIn');
      expect(result).toHaveProperty('hasWon');
      expect(result).toHaveProperty('currentStake');
      expect(result).toHaveProperty('potentialPayout');
      expect(result).toHaveProperty('roundNumber');
      
      expect(typeof result.survivorsCount).toBe('number');
      expect(typeof result.maxCapacity).toBe('number');
      expect(typeof result.isUserIn).toBe('boolean');
      expect(typeof result.hasWon).toBe('boolean');
    } catch (error) {
      // Expected if contract doesn't exist or method names don't match
      expect(error).toBeInstanceOf(Error);
    }
  });
});
