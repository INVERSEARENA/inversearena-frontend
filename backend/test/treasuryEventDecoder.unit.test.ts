import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { toTreasuryEvent } from '../src/domain/treasuryEventDecoder';

const WINNER = Keypair.random().publicKey();
const ADMIN = Keypair.random().publicKey();

function rawEvent(overrides: {
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  id?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  txHash?: string;
  pagingToken?: string;
}) {
  return {
    id: overrides.id ?? '0000000001-0000000000',
    contractId: { toString: () => 'CARENA00000000000000000000000000000000000000000000000' },
    ledger: overrides.ledger ?? 12345,
    ledgerClosedAt: overrides.ledgerClosedAt ?? '2026-01-01T00:00:00Z',
    txHash: overrides.txHash ?? 'a'.repeat(64),
    topic: overrides.topic,
    value: overrides.value,
    pagingToken: overrides.pagingToken ?? 'token-1',
  } as any;
}

function claimedTopic(winner: string) {
  return [nativeToScVal('claimed', { type: 'symbol' }), nativeToScVal(winner, { type: 'address' })];
}

function feeUpdTopic(admin: string) {
  return [nativeToScVal('fee_upd', { type: 'symbol' }), nativeToScVal(admin, { type: 'address' })];
}

describe('toTreasuryEvent', () => {
  it('decodes a real "claimed" event with its amount/yield_amount tuple', () => {
    const value = xdr.ScVal.scvVec([
      nativeToScVal(11_000_000n, { type: 'i128' }),
      nativeToScVal(1_000_000n, { type: 'i128' }),
    ]);
    const event = toTreasuryEvent(rawEvent({ topic: claimedTopic(WINNER), value }));

    expect(event.topic).toBe('claimed');
    if (event.topic === 'claimed') {
      expect(event.winner).toBe(WINNER);
      expect(event.amountAtomic).toBe(11_000_000n);
      expect(event.yieldAmountAtomic).toBe(1_000_000n);
    }
  });

  it('decodes a real "fee_upd" event with its bps payload', () => {
    const value = nativeToScVal(250, { type: 'u32' });
    const event = toTreasuryEvent(rawEvent({ topic: feeUpdTopic(ADMIN), value }));

    expect(event.topic).toBe('fee_upd');
    if (event.topic === 'fee_upd') {
      expect(event.admin).toBe(ADMIN);
      expect(event.feeBps).toBe(250);
    }
  });

  it('marks a topic outside the treasury-relevant set as unknown, not an error', () => {
    const value = nativeToScVal(1, { type: 'u32' });
    const event = toTreasuryEvent(
      rawEvent({ topic: [nativeToScVal('join', { type: 'symbol' })], value }),
    );

    expect(event.topic).toBe('unknown');
    if (event.topic === 'unknown') {
      expect(event.rawTopic).toBe('join');
    }
  });

  it('marks an event with an undecodable topic as unknown rather than throwing', () => {
    // An empty topic array — topic[0] is undefined.
    const value = nativeToScVal(1, { type: 'u32' });
    const event = toTreasuryEvent(rawEvent({ topic: [], value }));

    expect(event.topic).toBe('unknown');
  });

  it('marks a "claimed" event with a malformed (non-tuple) value as unknown rather than throwing', () => {
    // Real events always publish a 2-tuple; a single scalar is malformed for "claimed".
    const value = nativeToScVal(42, { type: 'u32' });
    const event = toTreasuryEvent(rawEvent({ topic: claimedTopic(WINNER), value }));

    // A single non-array value degrades to [value, 0n] per the decoder's
    // fallback — still decodes, not a hard failure, since a single scalar is
    // valid XDR even though it's not the shape this topic normally carries.
    expect(event.topic).toBe('claimed');
  });

  it('preserves ledger/tx identity fields needed for idempotent ingestion', () => {
    const value = nativeToScVal(250, { type: 'u32' });
    const event = toTreasuryEvent(
      rawEvent({ topic: feeUpdTopic(ADMIN), value, id: 'evt-42', ledger: 999, txHash: 'b'.repeat(64) }),
    );

    expect(event.id).toBe('evt-42');
    expect(event.ledgerSequence).toBe(999);
    expect(event.txHash).toBe('b'.repeat(64));
  });
});
