import { describe, it, expect } from "@jest/globals";
import {
  CONTRACT_ERROR_MESSAGES,
  SAC_ERRORS,
  contractErrorName,
  userMessageForContractError,
} from "../contract-error-registry";
import { CONTRACT_ERRORS, type ContractKind } from "../contract-errors.generated";

describe("contract-error-registry", () => {
  it("resolves the same code to different variants per contract (#1597)", () => {
    expect(contractErrorName({ kind: "arena", code: 5 })).toBe("RoundNotStarted");
    expect(contractErrorName({ kind: "factory", code: 5 })).toBe("InsufficientCreatorStake");
    expect(contractErrorName({ kind: "sac", code: 10 })).toBe("BalanceError");
    expect(contractErrorName({ kind: null, code: 5 })).toBeNull();
  });

  it("uses override copy and always names the contract error", () => {
    expect(userMessageForContractError({ kind: "arena", code: 1 })).toBe(
      "You do not have permission to perform this action. (ArenaError::Unauthorized, code 1)",
    );
  });

  it("falls back to the variant name when there is no override", () => {
    expect(userMessageForContractError({ kind: "factory", code: 8 })).toBe(
      "The factory contract rejected this action (HostNotWhitelisted). (FactoryError::HostNotWhitelisted, code 8)",
    );
  });

  it("reports undeclared codes and unknown contracts without borrowing copy", () => {
    expect(userMessageForContractError({ kind: "payout", code: 7 })).toBe(
      "The payout contract could not complete this action (PayoutError code 7).",
    );
    expect(userMessageForContractError({ kind: null, code: 1 })).toBe(
      "The contract could not complete this action (on-chain code 1).",
    );
  });

  it("only overrides variants the generated tables declare", () => {
    for (const [kind, overrides] of Object.entries(CONTRACT_ERROR_MESSAGES)) {
      const declared = new Set<string>(
        Object.values(kind === "sac" ? SAC_ERRORS.codes : CONTRACT_ERRORS[kind as ContractKind].codes),
      );
      for (const [name, message] of Object.entries(overrides ?? {})) {
        expect(declared.has(name)).toBe(true);
        expect(message.length).toBeGreaterThan(10);
      }
    }
  });

  it("keeps copy for every player-facing arena error", () => {
    for (const code of [7, 8, 9, 12, 13, 16, 20, 21, 22, 25, 26, 27, 29, 33, 44]) {
      const name = contractErrorName({ kind: "arena", code })!;
      expect(CONTRACT_ERROR_MESSAGES.arena).toHaveProperty(name);
    }
  });
});
