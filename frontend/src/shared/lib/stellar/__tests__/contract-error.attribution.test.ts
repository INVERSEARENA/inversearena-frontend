/**
 * Contract-qualified error parsing (#1597): an `Error(Contract, #N)` is read
 * from the enum of the contract that raised it, using the simulation's
 * diagnostic events and the invoking contract.
 */
import { describe, expect, it } from "@jest/globals";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import {
  ContractErrorCode,
  SimulationFailedError,
  parseContractError,
} from "../contract-error";

function contractId(byte: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, byte));
}

const ARENA = contractId(9);
const FACTORY = contractId(1);
const USDC = contractId(2);
const STRANGER = contractId(3);

jest.mock("@/shared/config/stellarConfig", () => {
  const { StrKey: keys } = jest.requireActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk",
  );
  const id = (byte: number) => keys.encodeContract(Buffer.alloc(32, byte));
  return {
    stellarConfig: {
      factoryContractId: id(1),
      usdcContractId: id(2),
      xlmContractId: undefined,
      stakingContractId: undefined,
      rwaVaultContractId: undefined,
      oracleContractId: undefined,
    },
  };
});

/** The `error` diagnostic event the host records where a contract error occurs. */
function errorEvent(raisedBy: string, code: number): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      // stellar-base types `ContractId` as `Opaque[]`; at runtime it is the 32-byte Buffer.
      contractId: StrKey.decodeContract(raisedBy) as unknown as xdr.ContractId,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  });
}

function simulationFailure(code: number, events: Array<xdr.DiagnosticEvent | string>) {
  return new SimulationFailedError({ error: `HostError: Error(Contract, #${code})`, events });
}

const invokeArena = { kind: "arena", contractId: ARENA } as const;

describe("parseContractError attribution", () => {
  it("attributes a nested factory error to the factory, not the invoked arena", () => {
    const result = parseContractError(
      simulationFailure(15, [errorEvent(FACTORY, 15), errorEvent(ARENA, 15)]),
      "buildJoinArenaTransaction",
      invokeArena,
    );

    expect(result.code).toBe(ContractErrorCode.SIMULATION_FAILED);
    expect(result.contractError).toEqual({ kind: "factory", code: 15, name: "ContractPaused" });
    expect(result.message).toContain("FactoryError::ContractPaused, code 15");
    // Arena code 15 is InvalidVaultAddress; its copy must not leak in.
    expect(result.message).not.toContain("vault address");
  });

  it("attributes a caught-and-rethrown error to the contract that returned it", () => {
    const result = parseContractError(
      simulationFailure(16, [errorEvent(FACTORY, 15), errorEvent(ARENA, 16)]),
      "buildJoinArenaTransaction",
      invokeArena,
    );
    expect(result.contractError).toEqual({ kind: "arena", code: 16, name: "ContractPaused" });
    expect(result.message).toContain("The contract is paused");
  });

  it("attributes a token error to the Stellar Asset Contract", () => {
    const result = parseContractError(
      simulationFailure(10, [errorEvent(USDC, 10)]),
      "buildJoinArenaTransaction",
      invokeArena,
    );
    expect(result.contractError).toEqual({ kind: "sac", code: 10, name: "BalanceError" });
    expect(result.message).toContain("token balance is too low");
  });

  it("decodes base64 diagnostic events from a raw simulation response", () => {
    const result = parseContractError(
      {
        error: "HostError: Error(Contract, #15)",
        events: [errorEvent(FACTORY, 15).toXDR("base64")],
      },
      "buildJoinArenaTransaction",
      invokeArena,
    );
    expect(result.contractError?.kind).toBe("factory");
  });

  it("falls back to the invoking contract when no event names the origin", () => {
    const result = parseContractError(simulationFailure(44, []), "buildJoinArenaTransaction", invokeArena);
    expect(result.contractError).toEqual({ kind: "arena", code: 44, name: "GloballyPaused" });
    expect(result.message).toContain("paused protocol-wide");
  });

  it("gives a generic message for an error from an unidentified contract", () => {
    const result = parseContractError(
      simulationFailure(5, [errorEvent(STRANGER, 5)]),
      "buildCreatePoolTransaction",
      { kind: "factory", contractId: FACTORY },
    );
    expect(result.contractError).toEqual({ kind: null, code: 5, name: null });
    expect(result.message).toContain("on-chain code 5");
    expect(result.message).not.toContain("InsufficientCreatorStake");
  });

  it("does not guess a contract without any invocation context", () => {
    const result = parseContractError({ error: "HostError: Error(Contract, #4)" }, "unknown");
    expect(result.contractError?.kind).toBeNull();
  });

  it("names a code the contract does not declare", () => {
    const result = parseContractError(simulationFailure(999, []), "test", invokeArena);
    expect(result.contractError).toEqual({ kind: "arena", code: 999, name: null });
    expect(result.message).toContain("ArenaError code 999");
  });

  it("leaves host errors out of the contract tables", () => {
    const result = parseContractError(
      new SimulationFailedError({ error: "HostError: Error(Budget, ExceededLimit)", events: [] }),
      "test",
      invokeArena,
    );
    expect(result.contractError).toBeUndefined();
    expect(result.message).toContain("resource budget");
  });
});
