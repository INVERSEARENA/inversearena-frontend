import { describe, expect, it } from "@jest/globals";
import { calculateSorobanFee } from "../soroban-fee-policy";

describe("Soroban fee policy (#1621)", () => {
  it("uses p50 inclusion and configurable resource headroom", () => {
    const quote = calculateSorobanFee({
      action: "commit", simulatedResourceFee: "1000",
      stats: { sorobanInclusionFee: { p50: "200", p90: "900" } },
      headroomBps: { commit: 1000 },
    });
    expect(quote.inclusionFee).toBe(200n);
    expect(quote.resourceFeeWithHeadroom).toBe(1100n);
    expect(quote.totalFee).toBe(1300n);
  });
  it("uses p90 near reveal deadline", () => {
    expect(calculateSorobanFee({
      action: "reveal", nearDeadline: true, simulatedResourceFee: 1000,
      stats: { sorobanInclusionFee: { p50: "200", p90: "900" } },
    }).inclusionFee).toBe(900n);
  });
  it("falls back safely when fee stats are absent", () => {
    const quote = calculateSorobanFee({ action: "other", simulatedResourceFee: "1" });
    expect(quote.usedFallback).toBe(true);
    expect(quote.inclusionFee).toBe(100n);
    expect(quote.resourceFeeWithHeadroom).toBe(2n);
  });
  it("rejects unsafe or fractional fee inputs", () => {
    expect(() => calculateSorobanFee({ action: "commit", simulatedResourceFee: "-1" })).toThrow();
    expect(() => calculateSorobanFee({ action: "commit", simulatedResourceFee: 1.5 })).toThrow();
    expect(() => calculateSorobanFee({
      action: "commit", simulatedResourceFee: 100,
      headroomBps: { commit: -1 },
    })).toThrow();
  });
});
