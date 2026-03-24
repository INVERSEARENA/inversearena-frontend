/**
 * Standardized error handling for all Soroban contract interactions.
 *
 * Every transaction builder and contract query throws a `ContractError`
 * on failure so that UI components can catch and display errors uniformly.
 *
 * On-chain numeric panic codes are documented in `contract/ERRORS.md` and mapped
 * to user copy via `./contract-error-registry.ts`.
 */

import { userMessageForContractPanicCode } from "@/shared-d/utils/contract-error-registry";

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

// ── ContractError class ──────────────────────────────────────────────
export class ContractError extends Error {
  /** Machine-readable error code */
  readonly code: ContractErrorCode;
  /** The builder / function that threw */
  readonly fn: string;
  /** Original error (if wrapping) */
  readonly cause?: unknown;

  constructor(opts: {
    code: ContractErrorCode;
    message?: string;
    fn: string;
    cause?: unknown;
  }) {
    const message = opts.message ?? DEFAULT_MESSAGES[opts.code];
    super(message);
    this.name = "ContractError";
    this.code = opts.code;
    this.fn = opts.fn;
    this.cause = opts.cause;

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
 * callers always receive a `ContractError`.
 */
export function parseContractError(
  error: unknown,
  fn: string,
): ContractError {
  // Already a ContractError — just return it
  if (error instanceof ContractError) {
    return error;
  }

  const msg = extractMessage(error);

  // ── Soroban simulation errors ────────────────────────────────────
  if (isSimulationError(error) || msg.includes("simulation")) {
    const detail = extractSimulationDetail(error);
    return new ContractError({
      code: ContractErrorCode.SIMULATION_FAILED,
      message: detail
        ? `Contract simulation failed: ${detail}`
        : undefined,
      fn,
      cause: error,
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
    message: msg || undefined,
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

/**
 * Extract a human-readable detail string from Soroban simulation errors.
 * Handles the common patterns returned by the Soroban RPC.
 */
function extractSimulationDetail(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const obj = error as Record<string, unknown>;

  // Direct error field from simulation response
  if ("error" in obj && typeof obj.error === "string") {
    return parseHostError(obj.error);
  }

  const msg = extractMessage(error);
  if (msg.includes("Error(Contract") || msg.includes("HostError")) {
    return parseHostError(msg);
  }

  return null;
}

/**
 * Parse Soroban HostError strings into something readable.
 * Example input: "HostError: Error(Contract, #4)"
 */
function parseHostError(raw: string): string {
  const contractMatch = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (contractMatch) {
    const code = Number.parseInt(contractMatch[1], 10);
    return userMessageForContractPanicCode(code);
  }

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
