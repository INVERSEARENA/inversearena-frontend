/**
 * Tests for #1386 — request-level idempotency on resolveRound/closeRound.
 *
 * A duplicate/retried command with the same idempotency key must produce
 * exactly one durable state transition, and must never re-run the
 * expensive side effect (on-chain submission) that a genuine replay would
 * otherwise repeat. A retry of a request that previously FAILED (or was
 * abandoned mid-flight) must still be allowed to proceed — #1344's
 * retryability guarantee for resolveRound must not regress.
 */

import { RoundState } from '../src/types/round';
import type { RoundInput } from '../src/types/round';
import { Money } from '../src/types/money';

jest.mock('../src/services/onChainReader', () => ({
  ...jest.requireActual('../src/services/onChainReader'),
  getOnChainActivePlayerIds: jest.fn(),
  getOnChainWinner: jest.fn(),
}));

jest.mock('../src/utils/metrics', () => ({
  ...jest.requireActual('../src/utils/metrics'),
  refreshArenaMetrics: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/cache/cacheService', () => ({
  invalidateArenaStats: jest.fn().mockResolvedValue(undefined),
}));

import { RoundService, SorobanOnChainReader, IdempotencyConflictError } from '../src/services/roundService';
import { getOnChainActivePlayerIds, getOnChainWinner } from '../src/services/onChainReader';

const mockGetActivePlayers = getOnChainActivePlayerIds as jest.Mock;
const mockGetWinner = getOnChainWinner as jest.Mock;

const ARENA_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const ROUND_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_A = '22222222-2222-4222-8222-222222222222';
const PLAYER_B = '33333333-3333-4333-8333-333333333333';

function buildInput(): RoundInput {
  return {
    roundId: ROUND_ID,
    playerChoices: [
      { userId: PLAYER_A, choice: 'heads', stake: Money.fromDisplayAmount('100', 'USDC') },
      { userId: PLAYER_B, choice: 'tails', stake: Money.fromDisplayAmount('100', 'USDC') },
    ],
    allActivePlayerIds: [PLAYER_A, PLAYER_B],
    oracleYield: 0,
    arenaContractId: ARENA_ID,
  };
}

/**
 * An in-memory fake standing in for IdempotentCommandRepository, matching
 * its interface exactly. Lets these tests exercise the real
 * runIdempotentCommand orchestration logic in RoundService without a live
 * Postgres connection — the repository itself (backed by a real Prisma
 * unique-constraint race) is covered separately.
 */
function buildFakeIdempotentCommandRepo() {
  const rows = new Map<
    string,
    { status: 'in_progress' | 'completed' | 'failed'; result: unknown; updatedAt: Date }
  >();

  return {
    rows,
    tryClaim: jest.fn(async (key: string) => {
      if (rows.has(key)) return null;
      rows.set(key, { status: 'in_progress', result: null, updatedAt: new Date() });
      return { idempotencyKey: key, status: 'in_progress' as const };
    }),
    findByKey: jest.fn(async (key: string) => {
      const row = rows.get(key);
      if (!row) return null;
      return { idempotencyKey: key, status: row.status, result: row.result, updatedAt: row.updatedAt };
    }),
    markCompleted: jest.fn(async (key: string, result: unknown) => {
      rows.set(key, { status: 'completed', result, updatedAt: new Date() });
    }),
    markFailed: jest.fn(async (key: string, _message: string) => {
      const row = rows.get(key);
      rows.set(key, { status: 'failed', result: row?.result ?? null, updatedAt: new Date() });
    }),
    reclaimForRetry: jest.fn(
      async (key: string, expectedStatus: 'failed' | 'in_progress', staleAfterMs: number) => {
        const row = rows.get(key);
        if (!row || row.status !== expectedStatus) return false;
        if (expectedStatus === 'in_progress' && Date.now() - row.updatedAt.getTime() < staleAfterMs) {
          return false;
        }
        rows.set(key, { status: 'in_progress', result: null, updatedAt: new Date() });
        return true;
      },
    ),
  };
}

function buildService(roundState: RoundState = RoundState.OPEN) {
  const resolveAtomically = jest.fn().mockResolvedValue(undefined);
  const closeAtomically = jest.fn().mockResolvedValue(undefined);
  const service = new RoundService({} as any, {} as any, new SorobanOnChainReader());

  (service as any).roundRepo = {
    findById: jest.fn().mockResolvedValue({
      id: ROUND_ID,
      roundNumber: 1,
      arenaId: 'arena-1',
      state: roundState,
    }),
    resolveAtomically,
    closeAtomically,
  };
  (service as any).submitOnChainResolve = jest.fn().mockResolvedValue(undefined);

  const idempotentCommands = buildFakeIdempotentCommandRepo();
  (service as any).idempotentCommands = idempotentCommands;

  return { service, resolveAtomically, closeAtomically, idempotentCommands };
}

describe('#1386 — resolveRoundIdempotent', () => {
  beforeEach(() => {
    mockGetActivePlayers.mockReset();
    mockGetWinner.mockReset();
  });

  it('normal path: executes once and records a completed row', async () => {
    mockGetActivePlayers.mockResolvedValue([PLAYER_A]);
    mockGetWinner.mockResolvedValue(null);
    const { service, resolveAtomically, idempotentCommands } = buildService();

    const result = await service.resolveRoundIdempotent('key-normal-1', buildInput());

    expect(result.eliminatedPlayers).toEqual([PLAYER_B]);
    expect(resolveAtomically).toHaveBeenCalledTimes(1);
    expect(idempotentCommands.rows.get('key-normal-1')?.status).toBe('completed');
  });

  it('duplicate delivery: a second call with the same key replays the cached result without a second on-chain submission', async () => {
    mockGetActivePlayers.mockResolvedValue([PLAYER_A]);
    mockGetWinner.mockResolvedValue(null);
    const { service, resolveAtomically } = buildService();
    const submitOnChainResolve = (service as any).submitOnChainResolve as jest.Mock;

    const first = await service.resolveRoundIdempotent('key-dup-1', buildInput());
    const second = await service.resolveRoundIdempotent('key-dup-1', buildInput());

    expect(second).toEqual(first);
    expect(submitOnChainResolve).toHaveBeenCalledTimes(1);
    expect(resolveAtomically).toHaveBeenCalledTimes(1);
  });

  it('concurrent requests: a still-in-progress claim rejects a second caller with IdempotencyConflictError, not a duplicate execution', async () => {
    mockGetActivePlayers.mockResolvedValue([PLAYER_A]);
    mockGetWinner.mockResolvedValue(null);
    const { service, idempotentCommands } = buildService();

    // Simulate the first request having already claimed the key but not
    // yet finished (e.g. still awaiting on-chain confirmation).
    idempotentCommands.rows.set('key-concurrent-1', {
      status: 'in_progress',
      result: null,
      updatedAt: new Date(),
    });

    await expect(service.resolveRoundIdempotent('key-concurrent-1', buildInput())).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  it('retry after failure: a prior FAILED row for the same key is retried, not rejected (#1344 retryability preserved)', async () => {
    mockGetActivePlayers.mockResolvedValue([PLAYER_A]);
    mockGetWinner.mockResolvedValue(null);
    const { service, resolveAtomically, idempotentCommands } = buildService();

    idempotentCommands.rows.set('key-retry-1', {
      status: 'failed',
      result: null,
      updatedAt: new Date(),
    });

    const result = await service.resolveRoundIdempotent('key-retry-1', buildInput());

    expect(result.eliminatedPlayers).toEqual([PLAYER_B]);
    expect(resolveAtomically).toHaveBeenCalledTimes(1);
    expect(idempotentCommands.rows.get('key-retry-1')?.status).toBe('completed');
  });

  it('restart during work: a stale IN_PROGRESS claim (older than the abandonment threshold) is released and retried', async () => {
    mockGetActivePlayers.mockResolvedValue([PLAYER_A]);
    mockGetWinner.mockResolvedValue(null);
    const { service, resolveAtomically, idempotentCommands } = buildService();

    idempotentCommands.rows.set('key-stale-1', {
      status: 'in_progress',
      result: null,
      updatedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes old
    });

    const result = await service.resolveRoundIdempotent('key-stale-1', buildInput());

    expect(result.eliminatedPlayers).toEqual([PLAYER_B]);
    expect(resolveAtomically).toHaveBeenCalledTimes(1);
  });

  it('a genuine on-chain failure marks the row failed and still propagates the error (round stays retryable)', async () => {
    mockGetActivePlayers.mockRejectedValue(new Error('rpc timeout'));
    const { service, resolveAtomically, idempotentCommands } = buildService();

    await expect(service.resolveRoundIdempotent('key-fail-1', buildInput())).rejects.toThrow('rpc timeout');

    expect(resolveAtomically).not.toHaveBeenCalled();
    expect(idempotentCommands.rows.get('key-fail-1')?.status).toBe('failed');
  });

  it('boundary: two different idempotency keys for the same round both execute independently', async () => {
    mockGetActivePlayers.mockResolvedValue([PLAYER_A]);
    mockGetWinner.mockResolvedValue(null);
    const { service, resolveAtomically } = buildService();

    await service.resolveRoundIdempotent('key-a', buildInput());
    await service.resolveRoundIdempotent('key-b', buildInput());

    expect(resolveAtomically).toHaveBeenCalledTimes(2);
  });
});

describe('#1386 — closeRoundIdempotent', () => {
  it('normal path: executes once and records a completed row', async () => {
    const { service, closeAtomically, idempotentCommands } = buildService(RoundState.OPEN);

    const result = await service.closeRoundIdempotent('key-close-1', ROUND_ID);

    expect(result.state).toBe(RoundState.CLOSED);
    expect(closeAtomically).toHaveBeenCalledTimes(1);
    expect(idempotentCommands.rows.get('key-close-1')?.status).toBe('completed');
  });

  it('duplicate delivery: a second call with the same key replays the cached result without a second state transition', async () => {
    const { service, closeAtomically } = buildService(RoundState.OPEN);

    const first = await service.closeRoundIdempotent('key-close-dup-1', ROUND_ID);
    const second = await service.closeRoundIdempotent('key-close-dup-1', ROUND_ID);

    expect(second).toEqual(first);
    expect(closeAtomically).toHaveBeenCalledTimes(1);
  });

  it('invalid-input path: closing a round that is not OPEN fails closed and is recorded as failed, not completed', async () => {
    const { service, closeAtomically, idempotentCommands } = buildService(RoundState.CLOSED);

    await expect(service.closeRoundIdempotent('key-close-invalid-1', ROUND_ID)).rejects.toThrow('not OPEN');

    expect(closeAtomically).not.toHaveBeenCalled();
    expect(idempotentCommands.rows.get('key-close-invalid-1')?.status).toBe('failed');
  });

  it('concurrent requests: a still-in-progress claim rejects a second caller', async () => {
    const { service, idempotentCommands } = buildService(RoundState.OPEN);

    idempotentCommands.rows.set('key-close-concurrent-1', {
      status: 'in_progress',
      result: null,
      updatedAt: new Date(),
    });

    await expect(service.closeRoundIdempotent('key-close-concurrent-1', ROUND_ID)).rejects.toThrow(
      IdempotencyConflictError,
    );
  });
});
