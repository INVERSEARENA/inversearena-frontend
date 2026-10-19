/**
 * Unit coverage for the typed on-chain read-availability taxonomy (#1519).
 *
 * Pure module: no SDK, no IO, no frontend import — so it runs under the
 * backend's default Jest config without the Mongo/Redis harness.
 */
import {
  absentRead,
  buildProvenance,
  classifyReadFailure,
  hasReadValue,
  isAbsentRead,
  isRetryableErrorCode,
  isStaleRead,
  isUnavailableRead,
  isVerifiedRead,
  OnChainReadUnavailableError,
  requireReadValue,
  staleRead,
  unavailableRead,
  verifiedRead,
} from "../src/types/onChainRead";

const provenance = buildProvenance({
  functionName: "get_player_count",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  network: "Test SDF Network ; September 2015",
  ledgerSequence: 42,
  observedAt: "2026-01-01T00:00:00.000Z",
});

describe("typed on-chain read results (#1519)", () => {
  it("builds provenance with defaults filled in", () => {
    const p = buildProvenance({
      functionName: "game_state",
      contractId: "C1",
      network: "testnet",
    });
    expect(p.ledgerSequence).toBeNull();
    expect(p.retryable).toBe(false);
    expect(typeof p.observedAt).toBe("string");
  });

  it("wraps a verified value and narrows with isVerifiedRead", () => {
    const result = verifiedRead(7, provenance);
    expect(isVerifiedRead(result)).toBe(true);
    expect(hasReadValue(result)).toBe(true);
    if (isVerifiedRead(result)) {
      expect(result.value).toBe(7);
      expect(result.provenance.ledgerSequence).toBe(42);
    }
  });

  it("treats a verified empty list as a real value, not a failure", () => {
    const result = verifiedRead<string[]>([], provenance);
    expect(isVerifiedRead(result)).toBe(true);
    expect(requireReadValue(result)).toEqual([]);
  });

  it("represents absence distinctly from a value", () => {
    const result = absentRead<number>(provenance);
    expect(isAbsentRead(result)).toBe(true);
    expect(hasReadValue(result)).toBe(false);
    expect(isVerifiedRead(result)).toBe(false);
  });

  it("treats a stale value as present but distinguishable", () => {
    const result = staleRead(3, provenance, 40);
    expect(isStaleRead(result)).toBe(true);
    expect(hasReadValue(result)).toBe(true);
    expect(requireReadValue(result)).toBe(3);
    if (isStaleRead(result)) expect(result.staleSinceLedger).toBe(40);
  });

  it("records unavailable reads as retryable or not, with a code", () => {
    const transient = unavailableRead<number>(provenance, "timeout", "timed out");
    expect(isUnavailableRead(transient)).toBe(true);
    if (isUnavailableRead(transient)) {
      expect(transient.error.code).toBe("timeout");
    }
    const permanent = unavailableRead<number>(provenance, "decode_error", "bad scval");
    if (isUnavailableRead(permanent)) {
      expect(permanent.error.code).toBe("decode_error");
    }
  });

  it("requireReadValue unwraps present values", () => {
    expect(requireReadValue(verifiedRead("Open", provenance))).toBe("Open");
    expect(requireReadValue(staleRead("Open", provenance))).toBe("Open");
  });

  it("requireReadValue throws a typed error for unavailable reads", () => {
    const result = unavailableRead<number>(provenance, "transport", "ECONNRESET");
    expect(() => requireReadValue(result)).toThrow(OnChainReadUnavailableError);
  });

  it("requireReadValue throws a typed error for absent reads", () => {
    const result = absentRead<number>(provenance);
    expect(() => requireReadValue(result)).toThrow(OnChainReadUnavailableError);
  });

  describe("classifyReadFailure", () => {
    it("maps known failure signals to stable codes", () => {
      expect(classifyReadFailure(new Error("RPC_URL_NOT_ALLOWED")).code).toBe(
        "rpc_url_not_allowed",
      );
      expect(
        classifyReadFailure(new Error("RPC_RESPONSE_TOO_LARGE")).code,
      ).toBe("response_too_large");
      expect(classifyReadFailure(new Error("Simulation error for game_state: x")).code).toBe(
        "simulation_error",
      );
      expect(
        classifyReadFailure(new Error("Simulation returned no result for game_state")).code,
      ).toBe("no_result");
      expect(classifyReadFailure(new Error("connect ECONNREFUSED 127.0.0.1")).code).toBe(
        "transport",
      );
      expect(classifyReadFailure(new Error("request timeout")).code).toBe("timeout");
      expect(classifyReadFailure(new Error("circuit breaker open")).code).toBe("circuit_open");
      expect(classifyReadFailure(new Error("cannot decode scval")).code).toBe("decode_error");
    });

    it("falls back to unknown for unrecognized errors", () => {
      expect(classifyReadFailure(new Error("something else")).code).toBe("unknown");
      expect(classifyReadFailure("a string").code).toBe("unknown");
    });

    it("classifies retryability consistently with the code", () => {
      expect(isRetryableErrorCode("transport")).toBe(true);
      expect(isRetryableErrorCode("timeout")).toBe(true);
      expect(isRetryableErrorCode("circuit_open")).toBe(true);
      expect(isRetryableErrorCode("no_result")).toBe(true);
      expect(isRetryableErrorCode("decode_error")).toBe(false);
      expect(isRetryableErrorCode("simulation_error")).toBe(false);
      expect(isRetryableErrorCode("rpc_url_not_allowed")).toBe(false);
      expect(isRetryableErrorCode("response_too_large")).toBe(false);
    });
  });
});
