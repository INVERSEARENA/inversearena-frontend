import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockSimulateTransaction = jest.fn();
const mockCreateContract = jest.fn();
const mockBuildGetFullStateCallOperation = jest.fn();

jest.mock("@/shared-d/utils/contract-client-factory", () => ({
  ContractClientFactory: jest.fn().mockImplementation(() => ({
    createRpcServer: () => ({
      simulateTransaction: mockSimulateTransaction,
    }),
    createContract: (...args: unknown[]) => mockCreateContract(...args),
  })),
}));

jest.mock("@/shared-d/utils/soroban-transaction-composer", () => ({
  composeUnsignedTransaction: jest.fn(() => ({ mockedTx: true })),
  buildGetFullStateCallOperation: (...args: unknown[]) =>
    mockBuildGetFullStateCallOperation(...args),
  buildClaimCallOperation: jest.fn(),
  buildCreatePoolCallOperation: jest.fn(),
  buildJoinCallOperation: jest.fn(),
  buildStakeCallOperation: jest.fn(),
  buildSubmitChoiceCallOperation: jest.fn(),
}));

jest.mock("@/shared-d/utils/stellar-scval-extract", () => ({
  extractU32FromScVal: jest
    .fn()
    .mockReturnValueOnce(5)
    .mockReturnValueOnce(128)
    .mockReturnValueOnce(3),
  extractI128FromScVal: jest.fn().mockReturnValueOnce(10).mockReturnValueOnce(20),
  extractBoolFromScVal: jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
  stroopsToDisplayAmount: jest.fn((value: bigint) => Number(value) / 10_000_000),
}));

describe("fetchArenaState single RPC optimization", () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset();
    mockCreateContract.mockReset();
    mockBuildGetFullStateCallOperation.mockReset();

    mockCreateContract.mockReturnValue({ call: jest.fn() });
    mockBuildGetFullStateCallOperation.mockReturnValue({ mockedOp: true });
    mockSimulateTransaction.mockResolvedValue({
      result: {
        retval: { mocked: true },
      },
    });
  });

  it("uses one simulation call for arena+user state", async () => {
    const { fetchArenaState } = await import("../stellar-transactions");
    const arenaId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const userAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    const result = await fetchArenaState(arenaId, userAddress);

    expect(mockBuildGetFullStateCallOperation).toHaveBeenCalledTimes(1);
    expect(mockBuildGetFullStateCallOperation.mock.calls[0]?.[1]).toBe(userAddress);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    expect(result.arenaId).toBe(arenaId);
    expect(result.isUserIn).toBe(true);
    expect(result.hasWon).toBe(false);
  });
});
