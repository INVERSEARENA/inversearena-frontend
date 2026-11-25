import { describe, it, expect } from "@jest/globals";
import { validateStakeAmount } from "../form-validation";

describe("validateStakeAmount", () => {
  const baseParams = {
    currency: "USDC" as const,
    minStake: 1,
    maxStake: 1000,
  };

  it("rejects multi-decimal input instead of silently truncating via parseFloat (#1241)", () => {
    // parseFloat("1.2.3") === 1.2, which would otherwise pass every
    // subsequent numeric check with a value that doesn't match the raw input.
    const result = validateStakeAmount({ amount: "1.2.3", ...baseParams });
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Please enter a valid amount");
  });

  it("rejects input with many decimal points", () => {
    const result = validateStakeAmount({ amount: "12.34.56.78", ...baseParams });
    expect(result.isValid).toBe(false);
  });

  it("still accepts a valid single-decimal amount", () => {
    const result = validateStakeAmount({ amount: "10.50", ...baseParams });
    expect(result.isValid).toBe(true);
  });
});
