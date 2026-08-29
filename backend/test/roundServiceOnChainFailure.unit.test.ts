/**
 * Regression tests for #1343.
 *
 * `getOnChainActivePlayerIds` used to catch RPC failures and return `[]`,
 * directly contradicting its own docstring. An empty active-player list is
 * indistinguishable from "every player was eliminated", so a transient RPC
 * hiccup after a successful `resolve_round` submission would write
 * elimination records for the entire lobby and commit the round as RESOLVED.
 *
 * The reader now throws `OnChainReadError`, and `resolveRound` must let that
 * propagate so nothing is persisted and the round stays retryable.
 */

import { RoundState } from '../src/types/round';
import type { RoundInput } from '../src/types/round';

// Keep the real OnChainReadError class — only the network-touching readers
// are stubbed, so `rejects.toThrow(OnChainReadError)` checks the real type.
jest.mock('../src/services/onChainReader', () => ({
  ...jest.requireActual('../src/services/onChainReader'),
  getOnChainActivePlayerIds: jest.fn(),
  getOnChainWinner: jest.fn(),
}));

// refreshArenaMetrics and the stats cache both reach for live infrastructure
// (Prisma, Redis) that this unit test has no business standing up.
jest.mock('../src/utils/metrics', () => ({
  ...jest.requireActual('../src/utils/metrics'),
  refreshArenaMetrics: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/cache/cacheService', () => ({
  invalidateArenaStats: jest.fn().mockResolvedValue(undefined),
}));

import { RoundService, SorobanOnChainReader } from '../src/services/roundService';
import {
  getOnChainActivePlayerIds,
  getOnChainWinner,
  OnChainReadError,
} from '../src/services/onChainReader';

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
      { userId: PLAYER_A, choice: 'heads', stake: 100 },
      { userId: PLAYER_B, choice: 'tails', stake: 100 },
    ],
    allActivePlayerIds: [PLAYER_A, PLAYER_B],
    oracleYield: 0,
    arenaContractId: ARENA_ID,
  };
}

/**
 * Builds a RoundService with the DB layer and the on-chain submission stubbed
 * out, so the only interesting failure surface is the `get_players` read.
 */
function buildService() {
  const resolveAtomically = jest.fn().mockResolvedValue(undefined);
  const service = new RoundService({} as any, {} as any, new SorobanOnChainReader());

  (service as any).roundRepo = {
    findById: jest.fn().mockResolvedValue({
      id: ROUND_ID,
      roundNumber: 1,
      arenaId: 'arena-1',
      state: RoundState.OPEN,
    }),
    resolveAtomically,
  };
  // resolve_round is submitted on-chain before the read; stub it as successful
  // so the failure under test is unambiguously the get_players read.
  (service as any).submitOnChainResolve = jest.fn().mockResolvedValue(undefined);

  return { service, resolveAtomically };
}

describe('#1343 — resolveRound with a failing get_players read', () => {
  beforeEach(() => {
    mockGetActivePlayers.mockReset();
    mockGetWinner.mockReset();
  });

  it('fails instead of marking every player eliminated', async () => {
    mockGetActivePlayers.mockRejectedValue(
      new OnChainReadError('get_players', ARENA_ID, new Error('rpc timeout')),
    );
    const { service } = buildService();

    await expect(service.resolveRound(buildInput())).rejects.toThrow(OnChainReadError);
  });

  it('does not commit the round as RESOLVED when the read fails', async () => {
    mockGetActivePlayers.mockRejectedValue(
      new OnChainReadError('get_players', ARENA_ID, new Error('rpc timeout')),
    );
    const { service, resolveAtomically } = buildService();

    await expect(service.resolveRound(buildInput())).rejects.toThrow();

    // The round must stay in its pre-resolution state so it can be retried.
    expect(resolveAtomically).not.toHaveBeenCalled();
  });

  it('still resolves normally when the read succeeds', async () => {
    // Only PLAYER_A survives — a genuine single elimination, not an RPC error.
    mockGetActivePlayers.mockResolvedValue([PLAYER_A]);
    mockGetWinner.mockResolvedValue(null);
    const { service, resolveAtomically } = buildService();

    const result = await service.resolveRound(buildInput());

    expect(result.eliminatedPlayers).toEqual([PLAYER_B]);
    expect(resolveAtomically).toHaveBeenCalledTimes(1);
  });
});

describe('#1343 — getOnChainActivePlayerIds error contract', () => {
  it('OnChainReadError carries the function and contract for diagnostics', () => {
    const cause = new Error('simulation failed');
    const err = new OnChainReadError('get_players', ARENA_ID, cause);

    expect(err.functionName).toBe('get_players');
    expect(err.contractId).toBe(ARENA_ID);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('simulation failed');
  });
});
