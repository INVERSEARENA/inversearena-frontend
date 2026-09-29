import { computeExpectedPlatformFee, classifyReconciliation, isLedgerFinalized } from '../src/domain/treasuryFeeMath';

describe('computeExpectedPlatformFee', () => {
  it('computes an exact bps cut via floor integer division', () => {
    expect(computeExpectedPlatformFee(1_000_000n, 1000)).toBe(100_000n); // 10%
  });

  it('multi-asset decimals: correct for a 6-decimal asset (USDC-scale atomic units)', () => {
    // 5.5 USDC (6 decimals) yield, 250 bps (2.5%) fee.
    expect(computeExpectedPlatformFee(5_500_000n, 250)).toBe(137_500n);
  });

  it('multi-asset decimals: correct for a 7-decimal asset (XLM-scale atomic units)', () => {
    // 5.5 XLM (7 decimals) yield, 250 bps fee.
    expect(computeExpectedPlatformFee(55_000_000n, 250)).toBe(1_375_000n);
  });

  it('floors a fractional remainder rather than rounding', () => {
    // 1 bps of 999 atomic units = 0.0999 -> floors to 0.
    expect(computeExpectedPlatformFee(999n, 1)).toBe(0n);
  });

  it('zero-fee configuration: 0 bps always yields 0', () => {
    expect(computeExpectedPlatformFee(123_456_789n, 0)).toBe(0n);
  });

  it('100% fee (10000 bps) returns the full yield amount', () => {
    expect(computeExpectedPlatformFee(42n, 10_000)).toBe(42n);
  });

  it('zero yield always yields 0 regardless of fee bps', () => {
    expect(computeExpectedPlatformFee(0n, 500)).toBe(0n);
  });

  it('rejects a negative yield amount', () => {
    expect(() => computeExpectedPlatformFee(-1n, 100)).toThrow();
  });

  it('rejects an out-of-range fee bps', () => {
    expect(() => computeExpectedPlatformFee(100n, 10_001)).toThrow();
    expect(() => computeExpectedPlatformFee(100n, -1)).toThrow();
  });
});

describe('classifyReconciliation', () => {
  const FINALIZED_BASE = { expectedAmountAtomic: 1000n, expectedDestination: null, actualTransfer: null, ledgerFinalized: true };

  it('unfinalized_ledger: an unfinalized ledger is pending regardless of everything else', () => {
    const result = classifyReconciliation({ ...FINALIZED_BASE, ledgerFinalized: false });
    expect(result).toEqual({ status: 'pending', discrepancyType: 'unfinalized_ledger' });
  });

  it('balanced: zero expected fee with no transfer', () => {
    const result = classifyReconciliation({ ...FINALIZED_BASE, expectedAmountAtomic: 0n });
    expect(result).toEqual({ status: 'balanced', discrepancyType: null });
  });

  it('unexpected_transfer: zero expected fee but a real transfer was found', () => {
    const result = classifyReconciliation({
      ...FINALIZED_BASE,
      expectedAmountAtomic: 0n,
      actualTransfer: { amountAtomic: 500n, destination: 'GTREASURY', txHash: 'deadbeef' },
    });
    expect(result).toEqual({ status: 'discrepant', discrepancyType: 'unexpected_transfer' });
  });

  it('missing_transfer: nonzero expected fee with no transfer found', () => {
    const result = classifyReconciliation(FINALIZED_BASE);
    expect(result).toEqual({ status: 'discrepant', discrepancyType: 'missing_transfer' });
  });

  it('amount_mismatch: a transfer was found but the amount differs', () => {
    const result = classifyReconciliation({
      ...FINALIZED_BASE,
      actualTransfer: { amountAtomic: 999n, destination: 'GTREASURY', txHash: 'deadbeef' },
    });
    expect(result).toEqual({ status: 'discrepant', discrepancyType: 'amount_mismatch' });
  });

  it('destination_mismatch: amount matches but destination differs from configured treasury', () => {
    const result = classifyReconciliation({
      ...FINALIZED_BASE,
      expectedDestination: 'GTREASURY',
      actualTransfer: { amountAtomic: 1000n, destination: 'GSOMEONE_ELSE', txHash: 'deadbeef' },
    });
    expect(result).toEqual({ status: 'discrepant', discrepancyType: 'destination_mismatch' });
  });

  it('balanced: amount and destination both match', () => {
    const result = classifyReconciliation({
      ...FINALIZED_BASE,
      expectedDestination: 'GTREASURY',
      actualTransfer: { amountAtomic: 1000n, destination: 'GTREASURY', txHash: 'deadbeef' },
    });
    expect(result).toEqual({ status: 'balanced', discrepancyType: null });
  });

  it('balanced: amount matches and no destination is configured yet (nothing to compare against)', () => {
    const result = classifyReconciliation({
      ...FINALIZED_BASE,
      expectedDestination: null,
      actualTransfer: { amountAtomic: 1000n, destination: 'GANYWHERE', txHash: 'deadbeef' },
    });
    expect(result).toEqual({ status: 'balanced', discrepancyType: null });
  });
});

describe('isLedgerFinalized', () => {
  it('is not finalized before the grace window elapses', () => {
    const closedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T00:01:00.000Z'); // 60s later
    expect(isLedgerFinalized(closedAt, now, 120)).toBe(false);
  });

  it('is finalized exactly at the grace window boundary', () => {
    const closedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-01T00:02:00.000Z'); // exactly 120s later
    expect(isLedgerFinalized(closedAt, now, 120)).toBe(true);
  });

  it('is finalized well after the grace window', () => {
    const closedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-01-02T00:00:00.000Z');
    expect(isLedgerFinalized(closedAt, now, 120)).toBe(true);
  });
});
