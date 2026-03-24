import { describe, it, expect } from "@jest/globals";
import { parseStellarError } from "../stellar-transactions";
import { ContractError, ContractErrorCode } from "../contract-error";

describe("parseStellarError", () => {
  it("returns ContractError message when already wrapped", () => {
    const err = new ContractError({
      code: ContractErrorCode.BAD_AUTH,
      fn: "submit",
    });
    expect(parseStellarError(err)).toBe(err.message);
  });

  it("delegates to parseContractError for Horizon-style strings", () => {
    expect(parseStellarError(new Error("tx_bad_auth"))).toContain(
      "wallet permissions",
    );
  });

  it("maps contract simulation host errors using the registry", () => {
    const msg = parseStellarError({
      error: "HostError: Error(Contract, #200)",
    });
    expect(msg).toContain("on-chain code 200");
    expect(msg).toContain("join this arena");
  });
});
