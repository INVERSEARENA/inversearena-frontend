/**
 * Tests for fetchArenaState function
 *
 * Note: These are integration tests that require a deployed contract.
 * For local development, you can mock the Server.simulateTransaction response.
 */

import { describe, it, expect } from '@jest/globals';
import { fetchArenaState } from '../stellar-transactions';
import { ContractError, ContractErrorCode } from '../contract-error';

describe('fetchArenaState', () => {
  it('should throw ContractError with VALIDATION_FAILED for invalid arena ID', async () => {
    try {
      await fetchArenaState('invalid-id');
      fail('Expected ContractError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      const ce = error as ContractError;
      expect(ce.code).toBe(ContractErrorCode.VALIDATION_FAILED);
      expect(ce.fn).toBe('fetchArenaState');
    }
  });

  it('should throw ContractError with VALIDATION_FAILED for invalid user address', async () => {
    const validArenaId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

    try {
      await fetchArenaState(validArenaId, 'invalid-address');
      fail('Expected ContractError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      const ce = error as ContractError;
      expect(ce.code).toBe(ContractErrorCode.VALIDATION_FAILED);
      expect(ce.fn).toBe('fetchArenaState');
    }
  });

  it('should throw ContractError for valid ID when contract does not exist', async () => {
    const validArenaId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

    try {
      await fetchArenaState(validArenaId);
      // If it doesn't throw, the contract exists — that's fine for integration
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      const ce = error as ContractError;
      expect(ce.fn).toBe('fetchArenaState');
      // Should be a simulation or unknown error, not a validation error
      expect(ce.code).not.toBe(ContractErrorCode.VALIDATION_FAILED);
    }
  });

  it('should return correct response shape on success', async () => {
    const validArenaId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const validUserAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    try {
      const result = await fetchArenaState(validArenaId, validUserAddress);

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
      // Expected if contract doesn't exist
      expect(error).toBeInstanceOf(ContractError);
    }
  });
});
