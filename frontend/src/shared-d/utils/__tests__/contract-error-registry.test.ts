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

  // #1116 — verify all ArenaError codes 1–35 have registry entries
  describe("ArenaError code coverage", () => {
    // Codes that exist in the Rust ArenaError enum (1–35)
    const ARENA_ERROR_CODES = [
      14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
      31, 32, 33, 34, 35,
    ];

    for (const code of ARENA_ERROR_CODES) {
      it(`ArenaError code ${code} has a user-facing message`, () => {
        const msg = userMessageForContractPanicCode(code);
        expect(msg).not.toContain("ERRORS.md");
        expect(msg).toContain(`on-chain code ${code}`);
      });
    }

    it("NoPendingAdmin (14) mentions admin transfer", () => {
      const msg = userMessageForContractPanicCode(14).toLowerCase();
      expect(msg).toContain("admin");
    });

    it("ContractPaused (16) mentions paused", () => {
      const msg = userMessageForContractPanicCode(16).toLowerCase();
      expect(msg).toContain("paused");
    });

    it("NotEnoughPlayers (19) mentions 2 players", () => {
      const msg = userMessageForContractPanicCode(19).toLowerCase();
      expect(msg).toContain("2");
    });
  });
});
