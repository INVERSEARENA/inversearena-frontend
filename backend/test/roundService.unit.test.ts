import fc from 'fast-check';
import { RoundService } from '../src/services/roundService';
import type { PlayerChoice, Payout } from '../src/types/round';

// Number of generated cases per property. Acceptance criteria requires 1,000+.
const NUM_RUNS = 1500;
// Floating-point tolerance for sum comparisons across many additions.
const EPSILON = 1e-6;

// computePayouts / computeEliminations are private on RoundService; they are
// pure (no DB access) so we can construct the service with a stub PrismaClient
// and reach them via an `any` cast.
const service = new RoundService({} as any);
const computeEliminations = (
  choices: PlayerChoice[],
  oracleYield: number,
  seed?: string
): string[] => (service as any).computeEliminations(choices, oracleYield, seed);
const computePayouts = (
  choices: PlayerChoice[],
  eliminated: string[],
  oracleYield: number
): Payout[] => (service as any).computePayouts(choices, eliminated, oracleYield);

// Generates a list of player choices with guaranteed-unique userIds (the
// payout logic keys on userId, so duplicates would be ill-defined).
const playerChoicesArb = fc
  .array(
    fc.record({
      stake: fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
      choice: fc.constantFrom('heads', 'tails'),
    }),
    { minLength: 2, maxLength: 20 }
  )
  .map((records) =>
    records.map((r, i): PlayerChoice => ({ userId: `user-${i}`, ...r }))
  );

const oracleYieldArb = fc.double({
  min: 0,
  max: 50,
  noNaN: true,
  noDefaultInfinity: true,
});

describe('RoundService.computePayouts invariants', () => {
  it('total payouts never exceed the total pool + yield (no funds created)', () => {
    fc.assert(
      fc.property(playerChoicesArb, oracleYieldArb, (playerChoices, oracleYield) => {
        const eliminated = computeEliminations(playerChoices, oracleYield);
        const payouts = computePayouts(playerChoices, eliminated, oracleYield);

        const totalStakes = playerChoices.reduce((s, p) => s + p.stake, 0);
        const totalPool = totalStakes * (1 + oracleYield / 100);
        const totalPayout = payouts.reduce((s, p) => s + p.amount, 0);

        expect(totalPayout).toBeLessThanOrEqual(totalPool + EPSILON);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('every winner receives at least their original stake back (no winner loses money)', () => {
    fc.assert(
      fc.property(playerChoicesArb, oracleYieldArb, (playerChoices, oracleYield) => {
        const eliminated = computeEliminations(playerChoices, oracleYield);
        const payouts = computePayouts(playerChoices, eliminated, oracleYield);

        const stakeByUser = new Map(playerChoices.map((p) => [p.userId, p.stake]));
        for (const payout of payouts) {
          const originalStake = stakeByUser.get(payout.userId)!;
          expect(payout.amount).toBeGreaterThanOrEqual(originalStake - EPSILON);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('distributes nothing when there are no winners (all players eliminated)', () => {
    fc.assert(
      fc.property(playerChoicesArb, oracleYieldArb, (playerChoices, oracleYield) => {
        // Eliminate everyone — there can be no winners to pay out.
        const allEliminated = playerChoices.map((p) => p.userId);
        const payouts = computePayouts(playerChoices, allEliminated, oracleYield);

        expect(payouts).toEqual([]);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
