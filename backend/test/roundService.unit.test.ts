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
  allActivePlayerIds: string[],
  oracleYield: number,
  seed?: string
): string[] => (service as any).computeEliminations(choices, allActivePlayerIds, oracleYield, seed);
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

const allActivePlayersArb = fc
  .array(fc.string({ minLength: 5, maxLength: 10 }), { minLength: 2, maxLength: 25 })
  .map((ids) => ids.map((id, i) => `${id}-${i}`));

const oracleYieldArb = fc.double({
  min: 0,
  max: 50,
  noNaN: true,
  noDefaultInfinity: true,
});

function makeAllActiveIds(choices: PlayerChoice[]): string[] {
  return choices.map(p => p.userId);
}

describe('RoundService.computePayouts invariants', () => {
  it('total payouts never exceed the total pool + yield (no funds created)', () => {
    fc.assert(
      fc.property(playerChoicesArb, oracleYieldArb, (playerChoices, oracleYield) => {
        const allActive = makeAllActiveIds(playerChoices);
        const eliminated = computeEliminations(playerChoices, allActive, oracleYield);
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
        const allActive = makeAllActiveIds(playerChoices);
        const eliminated = computeEliminations(playerChoices, allActive, oracleYield);
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

describe('RoundService.computeEliminations — majority elimination', () => {
  it('eliminates the majority side (heads majority)', () => {
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
      { userId: 'b', choice: 'heads', stake: 100 },
      { userId: 'c', choice: 'tails', stake: 100 },
    ];
    const eliminated = computeEliminations(choices, ['a', 'b', 'c'], 0);
    expect(eliminated.sort()).toEqual(['a', 'b']);
  });

  it('eliminates the majority side (tails majority)', () => {
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
      { userId: 'b', choice: 'tails', stake: 100 },
      { userId: 'c', choice: 'tails', stake: 100 },
    ];
    const eliminated = computeEliminations(choices, ['a', 'b', 'c'], 0);
    expect(eliminated.sort()).toEqual(['b', 'c']);
  });

  it('returns no eliminations on a tie', () => {
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
      { userId: 'b', choice: 'tails', stake: 100 },
    ];
    const eliminated = computeEliminations(choices, ['a', 'b'], 0);
    expect(eliminated).toEqual([]);
  });

  it('eliminates players who did not submit a choice', () => {
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
    ];
    const eliminated = computeEliminations(choices, ['a', 'b', 'c'], 0);
    expect(eliminated.sort()).toEqual(['b', 'c']);
  });

  it('eliminates non-submitters plus majority when choices exist', () => {
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
      { userId: 'b', choice: 'tails', stake: 100 },
      { userId: 'c', choice: 'tails', stake: 100 },
    ];
    const eliminated = computeEliminations(choices, ['a', 'b', 'c', 'd'], 0);
    expect(eliminated.sort()).toEqual(['b', 'c', 'd']);
  });

  it('handles single player remaining', () => {
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
    ];
    const eliminated = computeEliminations(choices, ['a'], 0);
    expect(eliminated).toEqual([]); // lone player = minority
  });

  it('all abstain — no choices submitted, all eliminated', () => {
    const eliminated = computeEliminations([], ['a', 'b', 'c'], 0);
    expect(eliminated.sort()).toEqual(['a', 'b', 'c']);
  });

  it('preserves oracleYield and randomSeed as metadata — elimination is count-based', () => {
    // Different oracleYield/randomSeed should not affect elimination outcome
    const choices: PlayerChoice[] = [
      { userId: 'a', choice: 'heads', stake: 100 },
      { userId: 'b', choice: 'tails', stake: 100 },
      { userId: 'c', choice: 'tails', stake: 100 },
    ];
    const result1 = computeEliminations(choices, ['a', 'b', 'c'], 10, 'seed-a');
    const result2 = computeEliminations(choices, ['a', 'b', 'c'], 50, 'seed-b');
    expect(result1).toEqual(result2);
  });
});
