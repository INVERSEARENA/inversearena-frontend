import { renderHook, act } from "@testing-library/react";
import { saveCommitment } from "@/shared/lib/stellar/commit-reveal";
import { useAutoReveal } from "../useAutoReveal";

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("useAutoReveal", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    saveCommitment("arena-1", 1, PUBLIC_KEY, {
      choice: "Heads",
      salt: new Uint8Array(32),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("waits until the chain-derived reveal phase", () => {
    const revealDeadline = Date.now() + 30_000;
    const { result } = renderHook(() =>
      useAutoReveal({
        arenaId: "arena-1",
        roundNumber: 1,
        phase: "commit",
        revealDeadline,
        publicKey: PUBLIC_KEY,
        signTransaction: jest.fn(),
      }),
    );

    expect(result.current).toEqual({ phase: "waiting", error: null });
  });

  it("transitions through signing, submitted, and confirmed", async () => {
    const signTransaction = jest.fn().mockResolvedValue("signed");
    const buildTransaction = jest.fn().mockResolvedValue({ toXDR: () => "unsigned" });
    const submitTransaction = jest.fn().mockResolvedValue(undefined);
    const revealDeadline = Date.now() + 30_000;
    const { result } = renderHook(() =>
      useAutoReveal({
        arenaId: "arena-1",
        roundNumber: 1,
        phase: "reveal",
        revealDeadline,
        publicKey: PUBLIC_KEY,
        signTransaction,
        buildTransaction,
        submitTransaction,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("confirmed");
    expect(signTransaction).toHaveBeenCalledWith("unsigned");
    expect(submitTransaction).toHaveBeenCalledWith("signed");
    expect(localStorage.getItem("inversearena:commit-reveal:arena-1:1:" + PUBLIC_KEY)).toBeNull();
  });

  it("backs off transient failures and stops on terminal reveal errors", async () => {
    const buildTransaction = jest.fn().mockResolvedValue({ toXDR: () => "unsigned" });
    const submitTransaction = jest
      .fn()
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockRejectedValueOnce(new Error("ChoiceAlreadyRevealed"));
    const revealDeadline = Date.now() + 30_000;
    const { result } = renderHook(() =>
      useAutoReveal({
        arenaId: "arena-1",
        roundNumber: 1,
        phase: "reveal",
        revealDeadline,
        publicKey: PUBLIC_KEY,
        signTransaction: jest.fn().mockResolvedValue("signed"),
        buildTransaction,
        submitTransaction,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("ready");
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
      // The retry awaits transaction construction, wallet signing, submission,
      // and the hook's state update; drain each promise continuation under the
      // fake clock before asserting the terminal result.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(result.current.phase).toBe("failed");
    expect(result.current.error).toContain("ChoiceAlreadyRevealed");
    expect(submitTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the salt is missing", async () => {
    const buildTransaction = jest.fn().mockRejectedValue(new Error("No commitment found for this round"));
    const signTransaction = jest.fn();
    const deadline = Date.now() + 30_000;
    const { result } = renderHook(() =>
      useAutoReveal({
        arenaId: "arena-1",
        roundNumber: 1,
        phase: "reveal",
        revealDeadline: deadline,
        publicKey: PUBLIC_KEY,
        signTransaction,
        buildTransaction,
      }),
    );

    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(result.current.phase).toBe("failed");
    expect(buildTransaction).toHaveBeenCalledTimes(1);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("does not retry a locked wallet", async () => {
    const buildTransaction = jest.fn().mockResolvedValue({ toXDR: () => "unsigned" });
    const signTransaction = jest.fn().mockRejectedValue(new Error("Wallet is locked"));
    const deadline = Date.now() + 30_000;
    const { result } = renderHook(() =>
      useAutoReveal({
        arenaId: "arena-1",
        roundNumber: 1,
        phase: "reveal",
        revealDeadline: deadline,
        publicKey: PUBLIC_KEY,
        signTransaction,
        buildTransaction,
      }),
    );
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(result.current.phase).toBe("failed");
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not sign after the contract reveal deadline", async () => {
    const signTransaction = jest.fn();
    const { result } = renderHook(() =>
      useAutoReveal({
        arenaId: "arena-1",
        roundNumber: 1,
        phase: "reveal",
        revealDeadline: Date.now() - 1,
        publicKey: PUBLIC_KEY,
        signTransaction,
      }),
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(result.current.phase).toBe("failed");
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
