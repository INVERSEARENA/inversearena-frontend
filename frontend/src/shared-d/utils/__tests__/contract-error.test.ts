import { describe, it, expect } from '@jest/globals';
import {
  ContractError,
  ContractErrorCode,
  parseContractError,
} from '../contract-error';

// ── ContractError class ──────────────────────────────────────────────

describe('ContractError', () => {
  it('should be an instance of Error', () => {
    const err = new ContractError({
      code: ContractErrorCode.UNKNOWN,
      fn: 'testFn',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ContractError);
  });

  it('should use default message when none provided', () => {
    const err = new ContractError({
      code: ContractErrorCode.ACCOUNT_NOT_FOUND,
      fn: 'getAccount',
    });
    expect(err.message).toBe('Account not found on network. Please fund it first.');
    expect(err.code).toBe(ContractErrorCode.ACCOUNT_NOT_FOUND);
    expect(err.fn).toBe('getAccount');
  });

  it('should use custom message when provided', () => {
    const err = new ContractError({
      code: ContractErrorCode.VALIDATION_FAILED,
      message: 'Custom validation message',
      fn: 'buildCreatePoolTransaction',
    });
    expect(err.message).toBe('Custom validation message');
  });

  it('should preserve cause', () => {
    const original = new Error('original');
    const err = new ContractError({
      code: ContractErrorCode.UNKNOWN,
      fn: 'test',
      cause: original,
    });
    expect(err.cause).toBe(original);
  });

  it('should have name "ContractError"', () => {
    const err = new ContractError({
      code: ContractErrorCode.UNKNOWN,
      fn: 'test',
    });
    expect(err.name).toBe('ContractError');
  });
});

// ── parseContractError ───────────────────────────────────────────────

describe('parseContractError', () => {
  it('should return existing ContractError as-is', () => {
    const original = new ContractError({
      code: ContractErrorCode.BAD_AUTH,
      fn: 'original',
    });
    const result = parseContractError(original, 'wrapper');
    expect(result).toBe(original);
    expect(result.fn).toBe('original');
  });

  // ── Zod errors ───────────────────────────────────────────────────

  it('should map ZodError to VALIDATION_FAILED', () => {
    const zodLike = {
      name: 'ZodError',
      message: 'Validation error',
      issues: [
        { message: 'Invalid public key' },
        { message: 'Amount must be positive' },
      ],
    };
    const result = parseContractError(zodLike, 'buildJoinArenaTransaction');
    expect(result.code).toBe(ContractErrorCode.VALIDATION_FAILED);
    expect(result.fn).toBe('buildJoinArenaTransaction');
    expect(result.message).toContain('Invalid public key');
    expect(result.message).toContain('Amount must be positive');
  });

  // ── User rejection ───────────────────────────────────────────────

  it('should detect user rejection from wallet', () => {
    const err = new Error('User rejected the transaction');
    const result = parseContractError(err, 'submit');
    expect(result.code).toBe(ContractErrorCode.USER_REJECTED);
  });

  it('should detect user cancel', () => {
    const result = parseContractError('user cancel', 'submit');
    expect(result.code).toBe(ContractErrorCode.USER_REJECTED);
  });

  // ── Insufficient funds ───────────────────────────────────────────

  it('should detect op_underfunded', () => {
    const err = new Error('op_underfunded');
    const result = parseContractError(err, 'submit');
    expect(result.code).toBe(ContractErrorCode.INSUFFICIENT_FUNDS);
  });

  it('should detect insufficient balance string', () => {
    const result = parseContractError('insufficient balance', 'submit');
    expect(result.code).toBe(ContractErrorCode.INSUFFICIENT_FUNDS);
  });

  // ── Auth errors ──────────────────────────────────────────────────

  it('should detect tx_bad_auth', () => {
    const err = new Error('tx_bad_auth');
    const result = parseContractError(err, 'submit');
    expect(result.code).toBe(ContractErrorCode.BAD_AUTH);
  });

  // ── Timeout ──────────────────────────────────────────────────────

  it('should detect tx_too_late', () => {
    const err = new Error('tx_too_late');
    const result = parseContractError(err, 'submit');
    expect(result.code).toBe(ContractErrorCode.TRANSACTION_TIMEOUT);
  });

  // ── Account not found ────────────────────────────────────────────

  it('should detect account not found', () => {
    const err = new Error('Account not found on network');
    const result = parseContractError(err, 'getAccount');
    expect(result.code).toBe(ContractErrorCode.ACCOUNT_NOT_FOUND);
  });

  it('should detect 404 status', () => {
    const err = new Error('Request failed with status 404');
    const result = parseContractError(err, 'getAccount');
    expect(result.code).toBe(ContractErrorCode.ACCOUNT_NOT_FOUND);
  });

  // ── Simulation errors ────────────────────────────────────────────

  it('should detect Soroban simulation error object', () => {
    const simError = {
      error: 'HostError: Error(Contract, #4)',
      message: 'simulation failed',
    };
    const result = parseContractError(simError, 'fetchArenaState');
    expect(result.code).toBe(ContractErrorCode.SIMULATION_FAILED);
    expect(result.message).toContain('on-chain code 4');
    expect(result.message).toContain('current game');
  });

  it('should detect HostError in message', () => {
    const err = new Error('HostError: Error(WasmVm, InvalidAction)');
    const result = parseContractError(err, 'buildStake');
    expect(result.code).toBe(ContractErrorCode.SIMULATION_FAILED);
    expect(result.message).toContain('WASM VM error');
  });

  it('should detect simulation keyword in message', () => {
    const err = new Error('Transaction simulation failed');
    const result = parseContractError(err, 'buildStake');
    expect(result.code).toBe(ContractErrorCode.SIMULATION_FAILED);
  });

  it('should detect Error(Contract, #N) pattern', () => {
    const err = { message: 'Error(Contract, #12)' };
    const result = parseContractError(err, 'test');
    expect(result.code).toBe(ContractErrorCode.SIMULATION_FAILED);
    expect(result.message).toContain('on-chain code 12');
    expect(result.message).toContain('ERRORS.md');
  });

  it('should prefer error field from simulation response objects', () => {
    const err = { error: 'HostError: Error(Contract, #7)', message: 'simulation failed' };
    const result = parseContractError(err, 'test');
    expect(result.code).toBe(ContractErrorCode.SIMULATION_FAILED);
    expect(result.message).toContain('on-chain code 7');
    expect(result.message).toContain('time window');
  });

  // ── Transaction failures ─────────────────────────────────────────

  it('should detect transaction failed', () => {
    const err = new Error('Transaction failed: FAILED');
    const result = parseContractError(err, 'submit');
    expect(result.code).toBe(ContractErrorCode.TRANSACTION_FAILED);
  });

  it('should detect validation failed', () => {
    const err = new Error('Transaction validation failed: FAILED');
    const result = parseContractError(err, 'submit');
    expect(result.code).toBe(ContractErrorCode.TRANSACTION_FAILED);
  });

  // ── Fallback ─────────────────────────────────────────────────────

  it('should fall back to UNKNOWN for unrecognized errors', () => {
    const err = new Error('something completely unexpected');
    const result = parseContractError(err, 'test');
    expect(result.code).toBe(ContractErrorCode.UNKNOWN);
    expect(result.message).toBe('something completely unexpected');
    expect(result.fn).toBe('test');
    expect(result.cause).toBe(err);
  });

  it('should handle null/undefined gracefully', () => {
    const result = parseContractError(null, 'test');
    expect(result.code).toBe(ContractErrorCode.UNKNOWN);
    expect(result).toBeInstanceOf(ContractError);
  });

  it('should handle plain string errors', () => {
    const result = parseContractError('op_underfunded in response', 'test');
    expect(result.code).toBe(ContractErrorCode.INSUFFICIENT_FUNDS);
  });
});
