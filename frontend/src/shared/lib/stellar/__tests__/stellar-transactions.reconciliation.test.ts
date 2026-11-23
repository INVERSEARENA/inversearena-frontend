/**
 * Unit tests for the deterministic client reconciliation engine (#1385).
 *
 * Covers the typed boundary between `submitSignedTransaction`'s outcome and
 * `reconcileTransaction`'s terminal resolution: normal (success / rejected /
 * timeout), boundary (exhausted retries, max-size input, duplicate delivery),
 * retry (Horizon converges after one or more attempts), and invalid-input
 * paths. Every test below relies on a distinct hash so the module-level
 * reconciliation cache cannot leak state between cases.
 */
import {
  captureTransactionOutcome,
  reconcileTransaction,
  ContractError,
  ContractErrorCode,
} from "../stellar-transactions";
import type {
  ReconciliationEvent,
  ReconciliationResult,
  TransactionOutcome,
} from "../stellar-transactions";

/** Deterministic, per-test unique hash (64 hex chars) so cache state is isolated. */
function hashFor(seed: string): string {
  return Buffer.from(seed + seed).toString("hex").padEnd(64, "0").slice(0, 64);
}

function successEvent(eventSink: jest.Mock): ReconciliationEvent {
  return eventSink.mock.calls.map((call) => call[0] as ReconciliationEvent).find((e) => e.event === "success")!;
}

describe("captureTransactionOutcome", () => {
  it("maps a TRANSACTION_TIMEOUT carrying a hash to a TIMEOUT outcome", () => {
    const error = new ContractError({
      code: ContractErrorCode.TRANSACTION_TIMEOUT,
      fn: "submitSignedTransaction",
      hash: hashFor("timeout"),
    });

    expect(captureTransactionOutcome(error)).toEqual({
      status: "TIMEOUT",
      hash: hashFor("timeout"),
    });
  });

  it("maps TRANSACTION_FAILED to a REJECTED outcome with its reason", () => {
    const error = new ContractError({
      code: ContractErrorCode.TRANSACTION_FAILED,
      fn: "submitSignedTransaction",
      hash: hashFor("failed"),
    });

    expect(captureTransactionOutcome(error)).toEqual({
      status: "REJECTED",
      hash: hashFor("failed"),
      reason: ContractErrorCode.TRANSACTION_FAILED,
    });
  });

  it("maps a non-ContractError through parseContractError (USER_REJECTED)", () => {
    const outcome = captureTransactionOutcome(
      new Error("User rejected request"),
    );

    expect(outcome).toEqual({
      status: "REJECTED",
      reason: ContractErrorCode.USER_REJECTED,
    });
  });

  it("maps a TRANSACTION_TIMEOUT without a hash to a REJECTED outcome (unrecoverable)", () => {
    const error = new ContractError({
      code: ContractErrorCode.TRANSACTION_TIMEOUT,
      fn: "submitSignedTransaction",
    });

    expect(captureTransactionOutcome(error)).toEqual({
      status: "REJECTED",
      reason: ContractErrorCode.TRANSACTION_TIMEOUT,
    });
  });
});

describe("reconcileTransaction — SUCCESS path", () => {
  it("resolves CONFIRMED deterministically with source rpc and zero retries", async () => {
    const eventSink = jest.fn();
    const hash = hashFor("success");
    const fetchFn = jest
      .fn()
      .mockRejectedValue(new Error("fetch must not be called for SUCCESS"));

    const result = await reconcileTransaction(
      { status: "SUCCESS", hash },
      { fetchFn, eventSink },
    );

    expect(result).toMatchObject<Partial<ReconciliationResult>>({
      resolved: "CONFIRMED",
      hash,
      retries: 0,
      latencyMs: 0,
      source: "rpc",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(successEvent(eventSink)).toMatchObject<Partial<ReconciliationEvent>>({
      event: "success",
      resolved: "CONFIRMED",
      source: "rpc",
      retries: 0,
    });
  });
});

describe("reconcileTransaction — REJECTED path", () => {
  it("resolves REJECTED immediately without touching the network", async () => {
    const eventSink = jest.fn();
    const hash = hashFor("rejected");
    const fetchFn = jest
      .fn()
      .mockRejectedValue(new Error("fetch must not be called for REJECTED"));

    const result = await reconcileTransaction(
      { status: "REJECTED", hash, reason: ContractErrorCode.BAD_AUTH },
      { fetchFn, eventSink },
    );

    expect(result).toMatchObject<Partial<ReconciliationResult>>({
      resolved: "REJECTED",
      hash,
      retries: 0,
      source: "rpc",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    const failure = eventSink.mock.calls
      .map((call) => call[0] as ReconciliationEvent)
      .find((e) => e.event === "failure")!;
    expect(failure).toMatchObject<Partial<ReconciliationEvent>>({
      event: "failure",
      resolved: "REJECTED",
      reason: ContractErrorCode.BAD_AUTH,
      source: "rpc",
    });
  });

  it("resolves REJECTED deterministically when no hash is available", async () => {
    const result = await reconcileTransaction({
      status: "REJECTED",
      reason: ContractErrorCode.VALIDATION_FAILED,
    });

    expect(result.resolved).toBe("REJECTED");
    expect(result.hash).toBe("");
    expect(result.retries).toBe(0);
    expect(result.source).toBe("rpc");
  });
});

describe("reconcileTransaction — TIMEOUT path", () => {
  it("converges to CONFIRMED once Horizon reports SUCCESS", async () => {
    const intervalMs = 1;
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ successful: true }),
      });

    const result = await reconcileTransaction(
      { status: "TIMEOUT", hash: hashFor("t1") },
      { fetchFn, intervalMs, maxAttempts: 5 },
    );

    expect(result.resolved).toBe("CONFIRMED");
    expect(result.source).toBe("horizon");
    expect(result.retries).toBeGreaterThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("emits a retry event for every Horizon 404 before converging", async () => {
    const eventSink = jest.fn();
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ successful: true }),
      });

    await reconcileTransaction(
      { status: "TIMEOUT", hash: hashFor("t2") },
      { fetchFn, intervalMs: 1, maxAttempts: 5, eventSink },
    );

    const retries = eventSink.mock.calls
      .map((call) => call[0] as ReconciliationEvent)
      .filter((e) => e.event === "retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]!.retries).toBe(1);
    expect(retries[1]!.retries).toBe(2);
    expect(successEvent(eventSink).resolved).toBe("CONFIRMED");
  });

  it("converges to REJECTED when Horizon reports FAILED", async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ successful: false }),
    });

    const result = await reconcileTransaction(
      { status: "TIMEOUT", hash: hashFor("t3") },
      { fetchFn, intervalMs: 1, maxAttempts: 5 },
    );

    expect(result.resolved).toBe("REJECTED");
    expect(result.source).toBe("horizon");
  });

  it("resolves UNKNOWN (never a hard failure) when Horizon exhausts maxAttempts", async () => {
    const eventSink = jest.fn();
    const fetchFn = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 });

    const result = await reconcileTransaction(
      { status: "TIMEOUT", hash: hashFor("t4") },
      { fetchFn, intervalMs: 1, maxAttempts: 3, eventSink },
    );

    expect(result.resolved).toBe("UNKNOWN");
    expect(result.source).toBe("horizon");
    expect(result.retries).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const timeout = eventSink.mock.calls
      .map((call) => call[0] as ReconciliationEvent)
      .find((e) => e.event === "timeout")!;
    expect(timeout).toMatchObject<Partial<ReconciliationEvent>>({
      event: "timeout",
      resolved: "UNKNOWN",
      retries: 3,
      source: "horizon",
    });
  });

  it("keeps retrying after a transient fetch-level error (treated as NOT_FOUND)", async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ successful: true }),
      });

    const result = await reconcileTransaction(
      { status: "TIMEOUT", hash: hashFor("t5") },
      { fetchFn, intervalMs: 1, maxAttempts: 5 },
    );

    expect(result.resolved).toBe("CONFIRMED");
  });

  it("correlates events with arenaId when provided", async () => {
    const eventSink = jest.fn();
    const hash = hashFor("t6");
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ successful: true }),
    });

    await reconcileTransaction(
      { status: "TIMEOUT", hash },
      { fetchFn, intervalMs: 1, maxAttempts: 3, eventSink, arenaId: "arena-abc" },
    );

    expect(successEvent(eventSink).arenaId).toBe("arena-abc");
  });
});

describe("reconcileTransaction — duplicate delivery and concurrency", () => {
  it("is idempotent: a terminal result is returned from cache on repeat delivery", async () => {
    const hash = hashFor("dup1");
    const fetchFn = jest
      .fn()
      .mockRejectedValue(new Error("fetch must not be called again"));

    const first = await reconcileTransaction({ status: "SUCCESS", hash });
    const second = await reconcileTransaction({ status: "SUCCESS", hash });

    expect(second).toBe(first);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("dedupes a repeated TIMEOUT for an already-UNKNOWN hash", async () => {
    const hash = hashFor("dup2");
    const fetchFn = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 });

    const first = await reconcileTransaction(
      { status: "TIMEOUT", hash },
      { fetchFn, intervalMs: 1, maxAttempts: 2 },
    );
    const second = await reconcileTransaction(
      { status: "TIMEOUT", hash },
      { fetchFn, intervalMs: 1, maxAttempts: 2 },
    );

    expect(first.resolved).toBe("UNKNOWN");
    expect(second).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("shares one deterministic outcome across concurrent requests for the same hash", async () => {
    const hash = hashFor("concurrent");
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ successful: true }),
    });

    const [a, b] = await Promise.all([
      reconcileTransaction(
        { status: "TIMEOUT", hash },
        { fetchFn, intervalMs: 1, maxAttempts: 3 },
      ),
      reconcileTransaction(
        { status: "TIMEOUT", hash },
        { fetchFn, intervalMs: 1, maxAttempts: 3 },
      ),
    ]);

    expect(a).toBe(b);
    expect(a.resolved).toBe("CONFIRMED");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileTransaction — invalid input", () => {
  it("throws VALIDATION_FAILED for an empty hash", async () => {
    await expect(
      reconcileTransaction({ status: "SUCCESS", hash: "" }),
    ).rejects.toMatchObject({
      code: ContractErrorCode.VALIDATION_FAILED,
    });
  });

  it("throws VALIDATION_FAILED for an over-long (max-size boundary) hash", async () => {
    await expect(
      reconcileTransaction({ status: "SUCCESS", hash: "x".repeat(200) }),
    ).rejects.toMatchObject({
      code: ContractErrorCode.VALIDATION_FAILED,
    });
  });

  it("throws VALIDATION_FAILED for an under-minimum hash", async () => {
    await expect(
      reconcileTransaction({ status: "TIMEOUT", hash: "short" }),
    ).rejects.toMatchObject({
      code: ContractErrorCode.VALIDATION_FAILED,
    });
  });
});

describe("reconcileTransaction — typed outcome exhaustiveness", () => {
  it.each<TransactionOutcome>([
    { status: "SUCCESS", hash: hashFor("ex1") },
    { status: "REJECTED", reason: ContractErrorCode.UNKNOWN },
    { status: "REJECTED", hash: hashFor("ex2"), reason: ContractErrorCode.BAD_AUTH },
    { status: "TIMEOUT", hash: hashFor("ex3") },
  ])("produces a reconciliation for %o", async (outcome) => {
    const fetchFn =
      outcome.status === "TIMEOUT"
        ? jest.fn().mockResolvedValue({ ok: false, status: 404 })
        : jest.fn().mockRejectedValue(new Error("unexpected fetch"));

    const result = await reconcileTransaction(outcome, {
      fetchFn,
      intervalMs: 1,
      maxAttempts: 1,
    });

    expect(result.outcome).toBe(outcome);
    expect(["CONFIRMED", "REJECTED", "UNKNOWN"]).toContain(result.resolved);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});