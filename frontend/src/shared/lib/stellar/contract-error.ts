/**
 * Standardized error handling for all Soroban contract interactions.
 *
 * Every transaction builder and contract query throws a `ContractError`
 * on failure so that UI components can catch and display errors uniformly.
 *
 * On-chain error codes are generated from the contract specs (see
 * `contract/ERRORS.md`) and only unique per contract, so a contract error is
 * attributed to the contract that raised it before `./contract-error-registry.ts`
 * picks its copy (#1597).
 */

import { StrKey, xdr } from "@stellar/stellar-sdk";
import { stellarConfig } from "@/shared/config/stellarConfig";
import {
  contractErrorName,
  userMessageForContractError,
  type ContractErrorRef,
  type ErrorSourceKind,
} from "@/shared/lib/stellar/contract-error-registry";

// ── Known error codes ────────────────────────────────────────────────
export enum ContractErrorCode {
  /** Input failed Zod / schema validation */
  VALIDATION_FAILED = "VALIDATION_FAILED",
  /** Horizon account lookup failed (not funded, network issue) */
  ACCOUNT_NOT_FOUND = "ACCOUNT_NOT_FOUND",
  /** Soroban simulation returned an error */
  SIMULATION_FAILED = "SIMULATION_FAILED",
  /** Transaction was rejected by the network */
  TRANSACTION_FAILED = "TRANSACTION_FAILED",
  /** Transaction timed out waiting for confirmation */
  TRANSACTION_TIMEOUT = "TRANSACTION_TIMEOUT",
  /** User cancelled signing in their wallet */
  USER_REJECTED = "USER_REJECTED",
  /** Insufficient balance for the operation */
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  /** Authorization / signature issue */
  BAD_AUTH = "BAD_AUTH",
  /** Required environment variable or config missing */
  CONFIG_MISSING = "CONFIG_MISSING",
  /** Catch-all for unexpected failures */
  UNKNOWN = "UNKNOWN",
}

// ── User-friendly default messages per code ──────────────────────────
const DEFAULT_MESSAGES: Record<ContractErrorCode, string> = {
  [ContractErrorCode.VALIDATION_FAILED]:
    "Invalid input. Please check the values and try again.",
  [ContractErrorCode.ACCOUNT_NOT_FOUND]:
    "Account not found on network. Please fund it first.",
  [ContractErrorCode.SIMULATION_FAILED]:
    "Contract simulation failed. The transaction may not be valid.",
  [ContractErrorCode.TRANSACTION_FAILED]:
    "Transaction was rejected by the network.",
  [ContractErrorCode.TRANSACTION_TIMEOUT]:
    "Transaction timed out waiting for confirmation. Please try again.",
  [ContractErrorCode.USER_REJECTED]:
    "Transaction was cancelled by the user.",
  [ContractErrorCode.INSUFFICIENT_FUNDS]:
    "Insufficient balance to cover the transaction and fees.",
  [ContractErrorCode.BAD_AUTH]:
    "Invalid or unauthorized transaction. Please check your wallet permissions.",
  [ContractErrorCode.CONFIG_MISSING]:
    "Required configuration is missing. Please check your environment setup.",
  [ContractErrorCode.UNKNOWN]:
    "An unknown error occurred during the transaction.",
};

/** The contract a transaction invokes, used to attribute its contract errors. */
export interface ContractInvocation {
  kind: ErrorSourceKind;
  contractId?: string | undefined;
}

/** A contract error attributed to its source contract, with its variant name when known. */
export interface ResolvedContractError extends ContractErrorRef {
  name: string | null;
}

/**
 * A failed simulation that keeps the RPC response, so its diagnostic events
 * can identify which contract raised the error (#1597). The SDK's
 * `prepareTransaction` throws a bare `Error(message)` that loses them.
 */
export class SimulationFailedError extends Error {
  constructor(
    readonly simulation: { error: string; events?: readonly (xdr.DiagnosticEvent | string)[] },
  ) {
    super(simulation.error);
    this.name = "SimulationFailedError";
  }
}

// ── ContractError class ──────────────────────────────────────────────
export class ContractError extends Error {
  /** Machine-readable error code */
  readonly code: ContractErrorCode;
  /** The builder / function that threw */
  readonly fn: string;
  /** Original error (if wrapping) */
  readonly cause?: unknown;
  /**
   * Transaction hash, when known (#1135) — set on TRANSACTION_TIMEOUT so a
   * caller can look the transaction up manually (Horizon, an explorer) when
   * confirmation couldn't be established before polling gave up. The
   * transaction may still succeed after this error is thrown.
   */
  readonly hash?: string | undefined;
  /** The on-chain contract error behind a SIMULATION_FAILED, when there was one. */
  readonly contractError?: ResolvedContractError | undefined;

  constructor(opts: {
    code: ContractErrorCode;
    message?: string;
    fn: string;
    cause?: unknown;
    hash?: string | undefined;
    contractError?: ResolvedContractError | undefined;
  }) {
    const message = opts.message ?? DEFAULT_MESSAGES[opts.code];
    super(message);
    this.name = "ContractError";
    this.code = opts.code;
    this.fn = opts.fn;
    this.cause = opts.cause;
    this.hash = opts.hash;
    this.contractError = opts.contractError;

    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ContractError);
    }
  }
}

// ── parseContractError ───────────────────────────────────────────────

/**
 * Maps a raw error (from Soroban simulation, Horizon, wallet, etc.)
 * into a typed `ContractError`.
 *
 * Call this inside the catch block of any transaction builder so that
 * callers always receive a `ContractError`. Pass the contract the
 * transaction invokes as `invocation` so a contract error code is read from
 * the right enum.
 */
export function parseContractError(
  error: unknown,
  fn: string,
  invocation?: ContractInvocation,
): ContractError {
  // Already a ContractError — just return it
  if (error instanceof ContractError) {
    return error;
  }

  const msg = extractMessage(error);

  // ── Soroban simulation errors ────────────────────────────────────
  if (isSimulationError(error) || msg.includes("simulation")) {
    const { detail, contractError } = describeSimulationFailure(error, invocation);
    return new ContractError({
      code: ContractErrorCode.SIMULATION_FAILED,
      ...(detail ? { message: `Contract simulation failed: ${detail}` } : {}),
      fn,
      cause: error,
      contractError,
    });
  }

  // ── Pattern matching on known strings ────────────────────────────
  if (msg.includes("User rejected") || msg.includes("user cancel")) {
    return new ContractError({
      code: ContractErrorCode.USER_REJECTED,
      fn,
      cause: error,
    });
  }

  if (msg.includes("op_underfunded") || msg.includes("insufficient")) {
    return new ContractError({
      code: ContractErrorCode.INSUFFICIENT_FUNDS,
      fn,
      cause: error,
    });
  }

  if (msg.includes("tx_bad_auth")) {
    return new ContractError({
      code: ContractErrorCode.BAD_AUTH,
      fn,
      cause: error,
    });
  }

  if (msg.includes("tx_too_late")) {
    return new ContractError({
      code: ContractErrorCode.TRANSACTION_TIMEOUT,
      fn,
      cause: error,
    });
  }

  if (msg.includes("Account not found") || msg.includes("status 404")) {
    return new ContractError({
      code: ContractErrorCode.ACCOUNT_NOT_FOUND,
      fn,
      cause: error,
    });
  }

  if (msg.includes("Transaction failed") || msg.includes("validation failed")) {
    return new ContractError({
      code: ContractErrorCode.TRANSACTION_FAILED,
      message: msg,
      fn,
      cause: error,
    });
  }

  // ── Zod validation errors ────────────────────────────────────────
  if (isZodError(error)) {
    const issues = (error as { issues: Array<{ message: string }> }).issues;
    const detail = issues.map((i) => i.message).join("; ");
    return new ContractError({
      code: ContractErrorCode.VALIDATION_FAILED,
      message: `Validation failed: ${detail}`,
      fn,
      cause: error,
    });
  }

  // ── Fallback ─────────────────────────────────────────────────────
  return new ContractError({
    code: ContractErrorCode.UNKNOWN,
    ...(msg ? { message: msg } : {}),
    fn,
    cause: error,
  });
}

// ── Helpers (private) ────────────────────────────────────────────────

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error
  ) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "");
}

function isZodError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "ZodError" &&
    "issues" in error
  );
}

/**
 * Detect Soroban simulation error response objects.
 * The Stellar SDK returns objects with an `error` field on failed simulations.
 */
function isSimulationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const obj = error as Record<string, unknown>;
  // Soroban RPC simulation failure shape
  if ("error" in obj && typeof obj.error === "string") return true;
  // Wrapped simulation errors from the SDK
  if (
    "message" in obj &&
    typeof obj.message === "string" &&
    (obj.message.includes("HostError") ||
      obj.message.includes("Error(Contract") ||
      obj.message.includes("Error(WasmVm"))
  ) {
    return true;
  }
  return false;
}

function simulationErrorText(error: unknown): string | null {
  if (error instanceof SimulationFailedError) return error.simulation.error;
  if (typeof error !== "object" || error === null) return null;
  const obj = error as Record<string, unknown>;
  if ("error" in obj && typeof obj.error === "string") return obj.error;
  const msg = extractMessage(error);
  return msg.includes("Error(Contract") || msg.includes("HostError") ? msg : null;
}

function simulationEvents(error: unknown): readonly (xdr.DiagnosticEvent | string)[] {
  const events =
    error instanceof SimulationFailedError
      ? error.simulation.events
      : (error as { events?: unknown } | null)?.events;
  return Array.isArray(events) ? events : [];
}

/**
 * Describe a failed simulation. A contract error is attributed to the
 * contract that raised it before its message is chosen; anything else is a
 * host error described by type.
 */
function describeSimulationFailure(
  error: unknown,
  invocation: ContractInvocation | undefined,
): { detail: string | null; contractError?: ResolvedContractError } {
  const raw = simulationErrorText(error);
  if (raw === null) return { detail: null };

  const contractMatch = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (!contractMatch) return { detail: describeHostError(raw) };

  const code = Number.parseInt(contractMatch[1]!, 10);
  const ref: ContractErrorRef = {
    kind: attributeContractError(code, simulationEvents(error), invocation),
    code,
  };
  return {
    detail: userMessageForContractError(ref),
    contractError: { ...ref, name: contractErrorName(ref) },
  };
}

/**
 * Identify which contract raised contract error `code`.
 *
 * The host records an `error` diagnostic event, attributed to the contract
 * executing at the time, wherever an error occurs. The earliest one carrying
 * the final code is its origin: a caller that catches a callee's failure and
 * returns its own error emits a later event with a different code. Without
 * such an event the error is attributed to the invoked contract.
 */
function attributeContractError(
  code: number,
  events: readonly (xdr.DiagnosticEvent | string)[],
  invocation: ContractInvocation | undefined,
): ErrorSourceKind | null {
  const origin = events.map(decodeContractErrorEvent).find((event) => event?.code === code);
  if (!origin) return invocation?.kind ?? null;
  if (origin.contractId === invocation?.contractId) return invocation.kind;
  return knownContractKinds().get(origin.contractId) ?? null;
}

function decodeContractErrorEvent(
  event: xdr.DiagnosticEvent | string,
): { contractId: string; code: number } | null {
  try {
    const contractEvent = (
      typeof event === "string" ? xdr.DiagnosticEvent.fromXDR(event, "base64") : event
    ).event();
    const contractId = contractEvent.contractId();
    const [name, value] = contractEvent.body().v0().topics();
    if (
      !contractId ||
      name?.switch().name !== "scvSymbol" ||
      name.sym().toString() !== "error" ||
      value?.switch().name !== "scvError"
    ) {
      return null;
    }
    const scError = value.error();
    if (scError.switch().name !== "sceContract") return null;
    // stellar-base types `Hash` as `Opaque[]`; at runtime it is the 32-byte Buffer.
    const idBytes = contractId as unknown as Buffer;
    return { contractId: StrKey.encodeContract(idBytes), code: scError.contractCode() };
  } catch {
    return null;
  }
}

/** Configured contracts an error can be attributed to besides the invoked one. */
function knownContractKinds(): Map<string, ErrorSourceKind> {
  const entries: Array<[string | undefined, ErrorSourceKind]> = [
    [stellarConfig.factoryContractId, "factory"],
    [stellarConfig.stakingContractId, "staking"],
    [stellarConfig.rwaVaultContractId, "rwa_adapter"],
    [stellarConfig.oracleContractId, "oracle"],
    [stellarConfig.usdcContractId, "sac"],
    [stellarConfig.xlmContractId, "sac"],
  ];
  return new Map(entries.filter((entry): entry is [string, ErrorSourceKind] => !!entry[0]));
}

/** Describe a host (non-contract) error such as `Error(Budget, ExceededLimit)`. */
function describeHostError(raw: string): string {
  // WasmVm errors
  const wasmMatch = raw.match(/Error\(WasmVm,\s*(\w+)\)/);
  if (wasmMatch) {
    return `WASM VM error: ${wasmMatch[1]}`;
  }

  // Budget exceeded
  if (raw.includes("Budget") || raw.includes("budget")) {
    return "Transaction exceeded resource budget limits";
  }

  // Storage errors
  if (raw.includes("Storage") || raw.includes("storage")) {
    return "Contract storage access error";
  }

  // Return trimmed raw if no pattern matched
  return raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
}
