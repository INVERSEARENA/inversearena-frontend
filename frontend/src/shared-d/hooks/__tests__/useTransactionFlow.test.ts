/**
 * useTransactionFlow hook unit tests — issue #1606.
 *
 * Tests the stage transitions, typed failure reasons, retry, and explorer
 * link generation without any real wallet / Soroban interaction.
 */

import { renderHook, act } from "@testing-library/react";
import { useTransactionFlow } from "@/shared-d/hooks/useTransactionFlow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(overrides: Partial<Parameters<typeof useTransactionFlow>[0]> = {}) {
  const builder = overrides.builder ?? jest.fn().mockResolvedValue("unsigned_xdr");
  const sign = overrides.sign ?? jest.fn().mockResolvedValue("signed_xdr");
  const submit = overrides.submit ?? jest.fn().mockResolvedValue("abc123_txhash");
  const confirm = overrides.confirm;
  const onSuccess = overrides.onSuccess ?? jest.fn();
  const onFailure = overrides.onFailure ?? jest.fn();
  const network = overrides.network ?? "testnet" as const;
  const timeoutMs = overrides.timeoutMs ?? 30_000;

  return renderHook(() =>
    useTransactionFlow({ builder, sign, submit, confirm, onSuccess, onFailure, network, timeoutMs })
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTransactionFlow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("starts in idle stage with no txHash or failure", () => {
    const { result } = makeFlow();
    expect(result.current.stage).toBe("idle");
    expect(result.current.txHash).toBeNull();
    expect(result.current.failureReason).toBeNull();
    expect(result.current.explorerUrl).toBeNull();
  });

  it("transitions through preparing → awaiting_signature → submitted → confirmed on success", async () => {
    const onSuccess = jest.fn();
    const { result } = makeFlow({ onSuccess });

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.stage).toBe("confirmed");
    expect(result.current.txHash).toBe("abc123_txhash");
    expect(result.current.explorerUrl).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc123_txhash"
    );
    expect(onSuccess).toHaveBeenCalledWith("abc123_txhash");
  });

  it("classifies user-rejected errors correctly", async () => {
    const sign = jest.fn().mockRejectedValue({ code: "USER_REJECTED" });
    const onFailure = jest.fn();
    const { result } = makeFlow({ sign, onFailure });

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.stage).toBe("failed");
    expect(result.current.failureReason).toBe("user_rejected");
    expect(onFailure).toHaveBeenCalledWith("user_rejected", expect.any(String));
  });

  it("classifies simulation failures correctly", async () => {
    const builder = jest.fn().mockRejectedValue({ code: "SimulationFailed" });
    const onFailure = jest.fn();
    const { result } = makeFlow({ builder, onFailure });

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.stage).toBe("failed");
    expect(result.current.failureReason).toBe("simulation_failed");
  });

  it("classifies submission failures correctly", async () => {
    const submit = jest.fn().mockRejectedValue({ code: "SubmissionFailed" });
    const onFailure = jest.fn();
    const { result } = makeFlow({ submit, onFailure });

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.stage).toBe("failed");
    expect(result.current.failureReason).toBe("submission_failed");
  });

  it("classifies timeout when confirm takes too long", async () => {
    const confirm = jest.fn().mockImplementation(
      () => new Promise<void>((_, reject) => setTimeout(() => reject({ code: "Timeout" }), 200))
    );
    const { result } = makeFlow({ confirm, timeoutMs: 100 });

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.stage).toBe("failed");
    expect(result.current.failureReason).toBe("timeout");
  });

  it("reset() returns the flow to idle", async () => {
    const { result } = makeFlow();

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.stage).toBe("confirmed");

    act(() => {
      result.current.reset();
    });

    expect(result.current.stage).toBe("idle");
    expect(result.current.txHash).toBeNull();
  });

  it("uses mainnet explorer URL when network is mainnet", async () => {
    const { result } = makeFlow({ network: "mainnet" });

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.explorerUrl).toBe(
      "https://stellar.expert/explorer/mainnet/tx/abc123_txhash"
    );
  });

  it("does not double-run when already in flight", async () => {
    const builder = jest.fn().mockImplementation(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("xdr"), 50))
    );
    const { result } = makeFlow({ builder });

    // Start two runs concurrently — second should be a no-op.
    await act(async () => {
      result.current.run();
      result.current.run();
      // Allow the first to complete.
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(builder).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe("confirmed");
  });
});
