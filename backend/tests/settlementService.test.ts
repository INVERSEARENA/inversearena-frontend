import {
  computeSettlementBreakdown,
  buildSettlementManifest,
  toReceiptCsv,
} from "../src/services/settlementService";
import type { TransactionRecord } from "../src/types/payment";

function baseTransaction(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: "tx-1",
    payoutId: "payout-1",
    idempotencyKey: "idem-1",
    sourceAccount: "GSOURCE",
    destinationAccount: "GDEST",
    asset: "XLM",
    amountStroops: "1000000000", // 100 XLM
    nonce: 1,
    status: "confirmed",
    unsignedXdr: "AAAA",
    signedXdr: "AAAA",
    txHash: "a".repeat(64),
    errorMessage: null,
    attempts: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:05:00.000Z"),
    confirmedAt: new Date("2026-01-01T00:05:00.000Z"),
    ownerId: null,
    ...overrides,
  };
}

describe("computeSettlementBreakdown", () => {
  const originalEnv = process.env.PLATFORM_FEE_BPS;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_FEE_BPS;
    else process.env.PLATFORM_FEE_BPS = originalEnv;
  });

  it("reconciles: principal + yieldAmount === netPayout + platformFee + dust (default 0 bps)", () => {
    delete process.env.PLATFORM_FEE_BPS;
    const b = computeSettlementBreakdown({
      winnerStake: 100,
      eliminatedStake: 300,
      oracleYieldPercent: 10,
    });

    expect(b.principal).toBe(400);
    expect(b.yieldAmount).toBeCloseTo(30, 7);
    expect(b.platformFee).toBe(0);
    expect(b.dust).toBe(0);
    expect(b.principal + b.yieldAmount).toBeCloseTo(b.netPayout + b.platformFee + b.dust, 7);
    // At the default 0 bps fee, netPayout is byte-for-byte what
    // roundService computed before this feature existed
    // (winnerStake + eliminatedStake * (1 + oracleYield/100)).
    expect(b.netPayout).toBeCloseTo(100 + 300 * 1.1, 7);
  });

  it("boundary: zero eliminated stake means zero yield, zero fee, zero dust", () => {
    const b = computeSettlementBreakdown({ winnerStake: 50, eliminatedStake: 0, oracleYieldPercent: 25 });
    expect(b.yieldAmount).toBe(0);
    expect(b.platformFee).toBe(0);
    expect(b.dust).toBe(0);
    expect(b.netPayout).toBe(50);
  });

  it("boundary: zero oracle yield means zero yield regardless of eliminated stake", () => {
    const b = computeSettlementBreakdown({ winnerStake: 50, eliminatedStake: 1000, oracleYieldPercent: 0 });
    expect(b.yieldAmount).toBe(0);
    expect(b.netPayout).toBe(1050);
  });

  it("deducts a configured platform fee from yield only, never principal, and reconciles", () => {
    process.env.PLATFORM_FEE_BPS = "1000"; // 10%
    const b = computeSettlementBreakdown({
      winnerStake: 100,
      eliminatedStake: 300,
      oracleYieldPercent: 10,
    });

    expect(b.yieldAmount).toBeCloseTo(30, 7);
    expect(b.platformFee).toBeCloseTo(3, 7); // 10% of yield, not of principal
    expect(b.netPayout).toBeCloseTo(100 + 300 + 30 - 3, 7); // principal untouched
    expect(b.principal + b.yieldAmount).toBeCloseTo(b.netPayout + b.platformFee + b.dust, 7);
  });

  it("captures dust from a fee that doesn't divide evenly at stroop precision", () => {
    process.env.PLATFORM_FEE_BPS = "333"; // 3.33%, likely to leave a remainder
    const b = computeSettlementBreakdown({
      winnerStake: 0,
      eliminatedStake: 7,
      oracleYieldPercent: 7,
    });

    expect(b.dust).toBeGreaterThanOrEqual(0);
    expect(b.principal + b.yieldAmount).toBeCloseTo(b.netPayout + b.platformFee + b.dust, 9);
  });

  it("rejects negative winnerStake", () => {
    expect(() =>
      computeSettlementBreakdown({ winnerStake: -1, eliminatedStake: 0, oracleYieldPercent: 0 }),
    ).toThrow(/negative/);
  });

  it("rejects negative eliminatedStake", () => {
    expect(() =>
      computeSettlementBreakdown({ winnerStake: 0, eliminatedStake: -1, oracleYieldPercent: 0 }),
    ).toThrow(/negative/);
  });

  it("rejects a negative or non-finite oracle yield", () => {
    expect(() =>
      computeSettlementBreakdown({ winnerStake: 0, eliminatedStake: 0, oracleYieldPercent: -1 }),
    ).toThrow(/oracleYieldPercent/);
    expect(() =>
      computeSettlementBreakdown({ winnerStake: 0, eliminatedStake: 0, oracleYieldPercent: Infinity }),
    ).toThrow(/oracleYieldPercent/);
  });

  it("ignores an out-of-range PLATFORM_FEE_BPS env var and falls back to the default", () => {
    process.env.PLATFORM_FEE_BPS = "20000"; // > 10000 bps is invalid
    const b = computeSettlementBreakdown({ winnerStake: 0, eliminatedStake: 100, oracleYieldPercent: 10 });
    expect(b.platformFee).toBe(0); // falls back to default (0), not a >100% fee
  });
});

describe("buildSettlementManifest", () => {
  it("uses the persisted breakdown when the transaction was created from a round settlement", () => {
    const tx = baseTransaction({
      amountStroops: "1270000000", // 127 XLM
      principal: 100,
      yieldAmount: 30,
      platformFee: 3,
      dust: 0,
    });

    const manifest = buildSettlementManifest(tx);

    expect(manifest.principal).toBe(100);
    expect(manifest.yieldAmount).toBe(30);
    expect(manifest.platformFee).toBe(3);
    expect(manifest.netPayout).toBeCloseTo(127, 7);
    expect(manifest.txHash).toBe(tx.txHash);
  });

  it("degrades gracefully for a lump-sum payout with no breakdown, without fabricating one", () => {
    const tx = baseTransaction({ amountStroops: "500000000" }); // 50 XLM, no breakdown fields

    const manifest = buildSettlementManifest(tx);

    expect(manifest.netPayout).toBeCloseTo(50, 7);
    expect(manifest.principal).toBeCloseTo(50, 7); // reports the lump as principal
    expect(manifest.yieldAmount).toBe(0);
    expect(manifest.platformFee).toBe(0);
    expect(manifest.dust).toBe(0);
  });

  it("reports a null txHash/confirmedAt for an unconfirmed transaction shape", () => {
    const tx = baseTransaction({ txHash: null, confirmedAt: null });
    const manifest = buildSettlementManifest(tx);
    expect(manifest.txHash).toBeNull();
    expect(manifest.confirmedAt).toBeNull();
  });
});

describe("toReceiptCsv", () => {
  it("renders a header row and a single data row", () => {
    const tx = baseTransaction({ principal: 100, yieldAmount: 30, platformFee: 3, dust: 0 });
    const csv = toReceiptCsv(buildSettlementManifest(tx));
    const lines = csv.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "payoutId,recipient,asset,principal,yieldAmount,platformFee,dust,netPayout,txHash,confirmedAt",
    );
    expect(lines[1]).toContain("payout-1");
    expect(lines[1]).toContain(tx.txHash!);
  });

  it("escapes a comma in a field so the row still parses as one record", () => {
    const tx = baseTransaction({ destinationAccount: "G,WITH,COMMAS" });
    const csv = toReceiptCsv(buildSettlementManifest(tx));
    expect(csv).toContain('"G,WITH,COMMAS"');
  });
});
