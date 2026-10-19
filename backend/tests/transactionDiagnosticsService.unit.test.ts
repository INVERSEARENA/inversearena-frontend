jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: jest.fn(),
    },
    rpc: {
      ...actual.rpc,
      Server: jest.fn(),
    },
  };
});

jest.mock("../src/config/stellarConfig", () => ({
  getStellarConfig: jest.fn(() => ({
    sorobanRpcUrl: "https://rpc.example.test",
    networkPassphrase: "Test SDF Network ; September 2015",
  })),
}));

import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { diagnoseTransaction } from "../src/services/transactionDiagnosticsService";

const mockedFromXDR = TransactionBuilder.fromXDR as jest.Mock;
const mockedServerCtor = rpc.Server as unknown as jest.Mock;

function mockSimulateTransaction(result: unknown) {
  const simulateTransaction = jest.fn().mockResolvedValue(result);
  mockedServerCtor.mockImplementation(() => ({ simulateTransaction }));
}

describe("diagnoseTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFromXDR.mockReturnValue({});
  });

  it("returns would_fail with a generic remediation for malformed xdr", async () => {
    mockedFromXDR.mockImplementation(() => {
      throw new Error("bad xdr");
    });

    const result = await diagnoseTransaction("not-valid-xdr");

    expect(result.outcome).toBe("would_fail");
    expect(result.contractCode).toBeNull();
    expect(result.remediation).toMatch(/could not be simulated/i);
  });

  it("returns would_succeed with footprint details for a successful simulation", async () => {
    mockSimulateTransaction({
      latestLedger: 12345,
      minResourceFee: "1000",
      transactionData: {
        build: () => ({
          resources: () => ({
            footprint: () => ({
              readOnly: () => [{}, {}],
              readWrite: () => [{}],
            }),
          }),
        }),
      },
    });

    const result = await diagnoseTransaction("valid-xdr");

    expect(result.outcome).toBe("would_succeed");
    expect(result.contractCode).toBeNull();
    expect(result.remediation).toBeNull();
    expect(result.footprint).toEqual({
      minResourceFeeStroops: "1000",
      readEntries: 2,
      writeEntries: 1,
    });
    expect(result.latestLedger).toBe(12345);
  });

  it("returns restore_required with restore remediation when a restore preamble is present", async () => {
    mockSimulateTransaction({
      latestLedger: 12345,
      minResourceFee: "1000",
      transactionData: {
        build: () => ({
          resources: () => ({
            footprint: () => ({ readOnly: () => [], readWrite: () => [] }),
          }),
        }),
      },
      restorePreamble: { minResourceFee: "2000", transactionData: {} },
    });

    const result = await diagnoseTransaction("valid-xdr");

    expect(result.outcome).toBe("restore_required");
    expect(result.remediation).toMatch(/must be restored/i);
  });

  it("extracts a known contract panic code and its remediation for a simulation error", async () => {
    mockSimulateTransaction({
      latestLedger: 12345,
      error: "HostError: Error(Contract, #22)",
      events: [],
    });

    const result = await diagnoseTransaction("valid-xdr");

    expect(result.outcome).toBe("would_fail");
    expect(result.contractCode).toBe(22);
    expect(result.remediation).toMatch(/This arena is full/i);
    expect(result.remediation).toMatch(/on-chain code 22/);
  });

  it("falls back to a generic remediation for an unrecognized contract panic code", async () => {
    mockSimulateTransaction({
      latestLedger: 12345,
      error: "HostError: Error(Contract, #9999)",
      events: [],
    });

    const result = await diagnoseTransaction("valid-xdr");

    expect(result.outcome).toBe("would_fail");
    expect(result.contractCode).toBe(9999);
    expect(result.remediation).toMatch(/could not complete this action/i);
  });

  it("falls back to a generic remediation for a non-contract simulation error", async () => {
    mockSimulateTransaction({
      latestLedger: 12345,
      error: "Budget exceeded",
      events: [],
    });

    const result = await diagnoseTransaction("valid-xdr");

    expect(result.outcome).toBe("would_fail");
    expect(result.contractCode).toBeNull();
    expect(result.remediation).toMatch(/could not be simulated/i);
  });

  it("never includes the raw RPC error string in the returned remediation", async () => {
    const rawError = "HostError: Error(Contract, #4): internal state dump XYZ123SECRET";
    mockSimulateTransaction({ latestLedger: 1, error: rawError, events: [] });

    const result = await diagnoseTransaction("valid-xdr");

    expect(result.remediation).not.toContain("XYZ123SECRET");
    expect(result.remediation).not.toContain("HostError");
  });
});
