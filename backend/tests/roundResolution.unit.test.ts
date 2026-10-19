import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoundResolution } from '../src/domain/roundResolution';
import { Money } from '../src/types/money';

const input = {
  allActivePlayerIds: ['winner', 'eliminated'],
  playerChoices: [
    { userId: 'winner', choice: 'heads', stake: Money.fromDisplayAmount('100', 'XLM') },
    { userId: 'eliminated', choice: 'tails', stake: Money.fromDisplayAmount('50', 'XLM') },
  ],
  oracleYield: 10,
};

test('buildRoundResolution derives eliminated balances and one on-chain winner payout', () => {
  const result = buildRoundResolution(input, ['winner'], 'winner');
  assert.deepEqual(result.eliminatedPlayers, ['eliminated']);
  assert.equal(result.poolBalances.winner?.toDisplayString(), '100.0000000');
  assert.equal(result.poolBalances.eliminated?.toDisplayString(), '0.0000000');
  assert.equal(result.payouts[0]?.amount.toDisplayString(), '155.0000000');
  assert.equal(result.payouts[0]?.principal.toDisplayString(), '150.0000000');
  assert.equal(result.payouts[0]?.yieldAmount.toDisplayString(), '5.0000000');
});

test('buildRoundResolution emits no payout while the on-chain game has no winner', () => {
  const result = buildRoundResolution(input, ['winner'], null);
  assert.deepEqual(result.payouts, []);
});

test('buildRoundResolution rejects a winner missing from the active choices', () => {
  assert.throws(
    () => buildRoundResolution(input, [], 'winner'),
    /not present in the active player choices/,
  );
});
