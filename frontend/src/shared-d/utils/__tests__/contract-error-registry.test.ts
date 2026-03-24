import { describe, it, expect } from "@jest/globals";
import {
  CONTRACT_PANIC_USER_MESSAGES,
  formatContractPanicMessage,
  userMessageForContractPanicCode,
} from "../contract-error-registry";

describe("contract-error-registry", () => {
  it("maps known panic codes with on-chain suffix", () => {
    expect(userMessageForContractPanicCode(1)).toContain("permission");
    expect(userMessageForContractPanicCode(1)).toContain("on-chain code 1");
  });

  it("uses fallback copy for unknown codes", () => {
    const msg = userMessageForContractPanicCode(99999);
    expect(msg).toContain("on-chain code 99999");
    expect(msg).toContain("ERRORS.md");
  });

  it("exposes every registry entry as non-empty", () => {
    for (const [code, text] of Object.entries(CONTRACT_PANIC_USER_MESSAGES)) {
      expect(text.length).toBeGreaterThan(10);
      expect(Number(code)).toBeGreaterThan(0);
    }
  });

  it("formatContractPanicMessage respects knownMessage override", () => {
    expect(formatContractPanicMessage(42, "Custom.")).toBe(
      "Custom. (on-chain code 42)",
    );
  });
});
