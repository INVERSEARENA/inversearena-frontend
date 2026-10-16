/**
 * Typed availability results for on-chain reads (#1519).
 *
 * Historically the arena read helpers collapsed every failure mode into a
 * benign value (`"Open"`, `0`, `[]`). That is unsafe because a transient RPC
 * outage becomes indistinguishable from a legitimate on-chain state: an empty
 * player list means "everyone was eliminated" and a `0` yield means "no yield
 * accrued", both irreversible interpretations.
 *
 * This module defines a single, explicit result taxonomy that every read
 * helper returns instead of throwing-or-defaulting:
 *
 *   - `verified`    — the contract answered and the value is authoritative.
 *   - `absent`      — the contract answered and legitimately holds no value
 *                     (e.g. no winner recorded yet). Distinct from an error.
 *   - `stale`       — a previously read value was served because the fresh
 *                     read could not corroborate it; carries the ledger at
 *                     which it was last observed.
 *   - `unavailable` — the read failed for an infrastructure/decoding reason;
 *                     no value may be inferred. `retryable` distinguishes a
 *                     transient RPC fault from a permanent decode/config bug.
 *
 * The types are intentionally pure (no SDK/IO imports) so they can be unit
 * tested in isolation and shared by every reader.
 */

export type OnChainReadOutcome = "verified" | "absent" | "stale" | "unavailable";

/**
 * Stable, low-cardinality classification of a failed read. Kept deliberately
 * small so it can be a metric label without blowing up series cardinality.
 */
export type OnChainReadErrorCode =
  | "rpc_url_not_allowed"
  | "response_too_large"
  | "timeout"
  | "transport"
  | "circuit_open"
  | "simulation_error"
  | "no_result"
  | "decode_error"
  | "unknown";

export interface OnChainReadProvenance {
  /** Contract function that was called, e.g. `get_player_count`. */
  functionName: string;
  /** Stellar contract ID the read targeted. */
  contractId: string;
  /** Network passphrase the read targeted. */
  network: string;
  /** Ledger the simulation observed against, when known. */
  ledgerSequence: number | null;
  /** ISO-8601 timestamp the result was produced at. */
  observedAt: string;
  /** Whether retrying the same read could plausibly succeed. */
  retryable: boolean;
}

export interface OnChainReadFailure {
  code: OnChainReadErrorCode;
  message: string;
}

export type OnChainReadResult<T> =
  | { outcome: "verified"; value: T; provenance: OnChainReadProvenance }
  | { outcome: "absent"; provenance: OnChainReadProvenance }
  | {
      outcome: "stale";
      value: T;
      provenance: OnChainReadProvenance;
      staleSinceLedger: number | null;
    }
  | {
      outcome: "unavailable";
      provenance: OnChainReadProvenance;
      error: OnChainReadFailure;
    };

/** Raised by {@link requireReadValue} when a caller demanded a present value. */
export class OnChainReadUnavailableError extends Error {
  constructor(
    readonly provenance: OnChainReadProvenance,
    readonly failure: OnChainReadFailure | null,
  ) {
    super(
      failure
        ? `On-chain read ${provenance.functionName} on ${provenance.contractId} was ${failure.code}: ${failure.message}`
        : `On-chain read ${provenance.functionName} on ${provenance.contractId} returned no value (absent)`,
    );
    this.name = "OnChainReadUnavailableError";
  }
}

export interface BuildProvenanceInput {
  functionName: string;
  contractId: string;
  network: string;
  ledgerSequence?: number | null;
  observedAt?: string;
  retryable?: boolean;
}

export function buildProvenance(input: BuildProvenanceInput): OnChainReadProvenance {
  return {
    functionName: input.functionName,
    contractId: input.contractId,
    network: input.network,
    ledgerSequence: input.ledgerSequence ?? null,
    observedAt: input.observedAt ?? new Date().toISOString(),
    retryable: input.retryable ?? false,
  };
}

export function verifiedRead<T>(
  value: T,
  provenance: OnChainReadProvenance,
): OnChainReadResult<T> {
  return { outcome: "verified", value, provenance };
}

export function absentRead<T>(
  provenance: OnChainReadProvenance,
): OnChainReadResult<T> {
  return { outcome: "absent", provenance };
}

export function staleRead<T>(
  value: T,
  provenance: OnChainReadProvenance,
  staleSinceLedger: number | null = null,
): OnChainReadResult<T> {
  return { outcome: "stale", value, provenance, staleSinceLedger };
}

export function unavailableRead<T>(
  provenance: OnChainReadProvenance,
  code: OnChainReadErrorCode,
  message: string,
): OnChainReadResult<T> {
  return { outcome: "unavailable", provenance, error: { code, message } };
}

export function isVerifiedRead<T>(
  result: OnChainReadResult<T>,
): result is Extract<OnChainReadResult<T>, { outcome: "verified" }> {
  return result.outcome === "verified";
}

export function isAbsentRead<T>(
  result: OnChainReadResult<T>,
): result is Extract<OnChainReadResult<T>, { outcome: "absent" }> {
  return result.outcome === "absent";
}

export function isStaleRead<T>(
  result: OnChainReadResult<T>,
): result is Extract<OnChainReadResult<T>, { outcome: "stale" }> {
  return result.outcome === "stale";
}

export function isUnavailableRead<T>(
  result: OnChainReadResult<T>,
): result is Extract<OnChainReadResult<T>, { outcome: "unavailable" }> {
  return result.outcome === "unavailable";
}

/**
 * True when the result carries an actual value (`verified` or `stale`).
 * Use when a stale-but-present value is acceptable to the caller; otherwise
 * check {@link isVerifiedRead} explicitly.
 */
export function hasReadValue<T>(
  result: OnChainReadResult<T>,
): result is
  | Extract<OnChainReadResult<T>, { outcome: "verified" }>
  | Extract<OnChainReadResult<T>, { outcome: "stale" }> {
  return result.outcome === "verified" || result.outcome === "stale";
}

/** Unwrap a present value or throw {@link OnChainReadUnavailableError}. */
export function requireReadValue<T>(result: OnChainReadResult<T>): T {
  if (hasReadValue(result)) return result.value;
  if (result.outcome === "unavailable") {
    throw new OnChainReadUnavailableError(result.provenance, result.error);
  }
  throw new OnChainReadUnavailableError(result.provenance, null);
}

/**
 * Classify an arbitrary thrown value into a stable error code and a
 * retryability flag. Message-substring based (not instance based) so it works
 * even when the error crossed a serialisation boundary, and pure so it can be
 * unit tested without the Stellar SDK.
 */
export function classifyReadFailure(error: unknown): OnChainReadFailure {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  if (/RPC_URL_NOT_ALLOWED/.test(message)) {
    return { code: "rpc_url_not_allowed", message };
  }
  if (/RPC_RESPONSE_TOO_LARGE/.test(message)) {
    return { code: "response_too_large", message };
  }
  if (/circuit/i.test(message) || /circuit/i.test(name)) {
    return { code: "circuit_open", message };
  }
  if (/timed? ?out|ETIMEDOUT|timeout/i.test(message)) {
    return { code: "timeout", message };
  }
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed/i.test(
      message,
    )
  ) {
    return { code: "transport", message };
  }
  if (/Simulation error/i.test(message)) {
    return { code: "simulation_error", message };
  }
  if (/returned no result/i.test(message)) {
    return { code: "no_result", message };
  }
  if (/decode|scval|xdr|invalid type|expected .* got/i.test(message)) {
    return { code: "decode_error", message };
  }
  return { code: "unknown", message };
}

/**
 * Whether a failed read is worth retrying. Decode/config failures are
 * deterministic and would fail identically on retry; transport/timeout/
 * circuit/no-result failures are transient.
 */
export function isRetryableErrorCode(code: OnChainReadErrorCode): boolean {
  switch (code) {
    case "timeout":
    case "transport":
    case "circuit_open":
    case "no_result":
    case "unknown":
      return true;
    case "rpc_url_not_allowed":
    case "response_too_large":
    case "simulation_error":
    case "decode_error":
      return false;
  }
}
