import { RoundService } from '../src/services/roundService';
import type { PlayerChoice } from '../src/types/round';

// computePayouts is private but pure enough to reach via `any` cast.
// Elimination logic was moved on-chain (#1098), so computeEliminations
// no longer exists as a local method — those tests have been removed.
const service = new RoundService({} as any);

jest.mock('../src/services/onChainReader', () => ({
  getOnChainActivePlayerIds: jest.fn(),
  getOnChainWinner: jest.fn(),
}));

import { getOnChainWinner } from '../src/services/onChainReader';
const mockGetOnChainWinner = getOnChainWinner as jest.Mock;

const ARENA_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

async function callComputePayouts(
  arenaId: string,
  choices: PlayerChoice[],
  eliminated: string[],
  oracleYield: number,
) {
  return (service as any).computePayouts(arenaId, choices, eliminated, oracleYield);
}

describe('RoundService.computePayouts', () => {
  beforeEach(() => {
    mockGetOnChainWinner.mockReset();
  });

  it('returns empty array when on-chain says no winner yet (game in progress)', async () => {
    mockGetOnChainWinner.mockResolvedValue(null);
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
      { userId: 'b', choice: 'tails', stake: 100 },
    ];
    const payouts = await callComputePayouts(ARENA_ID, choices, ['b'], 5);
    expect(payouts).toEqual([]);
  });

  it('pays the on-chain winner their stake + prize pool from eliminated stakes + yield', async () => {
    mockGetOnChainWinner.mockResolvedValue('a');
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
      { userId: 'b', choice: 'tails', stake: 100 },
    ];
    const eliminated = ['b'];
    const oracleYield = 10; // 10%
    const payouts = await callComputePayouts(ARENA_ID, choices, eliminated, oracleYield);

    // prizePool = eliminatedStake * (1 + yield/100) = 100 * 1.1 = 110
    // winner payout = winnerStake + prizePool = 100 + 110 = 210
    expect(payouts).toHaveLength(1);
    expect(payouts[0].userId).toBe('a');
    expect(payouts[0].amount).toBeCloseTo(210, 5);
  });

  it('winner receives at least their original stake (no loss)', async () => {
    mockGetOnChainWinner.mockResolvedValue('a');
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 50 },
      { userId: 'b', choice: 'tails', stake: 200 },
    ];
    const payouts = await callComputePayouts(ARENA_ID, choices, ['b'], 0);
    const winnerStake = 50;
    expect(payouts[0].amount).toBeGreaterThanOrEqual(winnerStake);
  });

  it('returns empty array when all players eliminated (on-chain winner missing from choices)', async () => {
    mockGetOnChainWinner.mockResolvedValue(null);
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
    ];
    const payouts = await callComputePayouts(ARENA_ID, choices, ['a'], 5);
    expect(payouts).toEqual([]);
  });
});
