/**
 * Centralized XDR signing policy firewall (#1502, extended for the
 * asset-readiness preflight in #1487).
 *
 * Every wallet sign request is validated against the decoded envelope *before*
 * the wallet prompt is shown. Only requests that pass every check reach
 * `wallet.signTransaction`. A rejection here is a **policy rejection**, not a
 * wallet rejection: the wallet was never asked, so the UI must not render it
 * as "the user cancelled".
 *
 * Checks, in order:
 *   1. the policy is not being evaluated against a foreign network
 *   2. the XDR decodes into a plain (non-fee-bump) `Transaction`
 *   3. the source is a syntactically valid Stellar public key
 *   4. timebounds are present, ordered, and not already expired
 *   5. the fee is at least the protocol minimum
 *   6. the sequence number is a positive integer
 *   7. the operation list is exactly what the requested op permits
 *   8. each decoded operation carries only the fields that op exposes
 *
 * Step 7 is what makes the firewall meaningful for `TRUSTLINE`: a
 * `changeTrust` is a classic operation carrying a spend of the account's base
 * reserve, and it must be the *only* operation in the envelope. A batched
 * "increase my limit and also do X" envelope is rejected outright rather than
 * being shown to the user as a trustline change.
 *
 * SDK notes (verified against `@stellar/stellar-sdk` 14.5.0 / `stellar-base`
 * 14.0.4):
 *   - `TransactionEnvelope` and `Fee` are **not** root exports in v14. Decode
 *     with `TransactionBuilder.fromXDR(xdr, passphrase)`, which returns
 *     `Transaction | FeeBumpTransaction`.
 *   - `Transaction` exposes `sequence` as a property (not `sequenceNumber()`)
 *     and `timeBounds` as a getter returning `{ minTime, maxTime }` as strings.
 *   - A decoded `changeTrust` `Operation` exposes `line` (an `Asset`) and
 *     `limit` (a decimal amount string) as own properties. That shape is read
 *     defensively — any deviation is treated as `malformed_xdr`, because a
 *     firewall must fail closed when it cannot understand the envelope.
 *
 * @module
 */

import {
  BASE_FEE,
  FeeBumpTransaction,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { stellarConfig } from "@/lib/stellarConfig";
import {
  SigningPolicyError,
  opLabels,
  type DecodedEnvelope,
  type DecodedOperationSummary,
  type ProtectedOpKey,
  type SigningPolicyErrorReason,
  type ValidationResult,
} from "./types";

/** `changeTrust` is the only operation the TRUSTLINE policy accepts. */
const CHANGE_TRUST_OPERATION = "changeTrust";

/**
 * SDK operation names each protected flow is allowed to carry.
 *
 * A single-entry set per op: the app builds every one of these transactions
 * with exactly one operation, so an envelope carrying more is not "a superset"
 * the UI could describe — it is an envelope nobody in this codebase produced,
 * which is the definition of a suspicious one.
 */
const ALLOWED_OPERATIONS: Record<ProtectedOpKey, ReadonlySet<string>> = {
  JOIN: new Set(["invokeHostFunction"]),
  CREATE: new Set(["invokeHostFunction"]),
  COMMIT: new Set(["invokeHostFunction"]),
  REVEAL: new Set(["invokeHostFunction"]),
  CLAIM: new Set(["invokeHostFunction"]),
  REFUND: new Set(["invokeHostFunction"]),
  STAKE: new Set(["invokeHostFunction"]),
  TRUSTLINE: new Set([CHANGE_TRUST_OPERATION]),
};

/** Human label for the single operation each protected flow permits. */
const EXPECTED_OPERATION_LABEL: Record<ProtectedOpKey, string> = {
  JOIN: "an arena contract call",
  CREATE: "a pool contract call",
  COMMIT: "a commitment contract call",
  REVEAL: "a reveal contract call",
  CLAIM: "a claim contract call",
  REFUND: "a refund contract call",
  STAKE: "a staking contract call",
  TRUSTLINE: "a changeTrust operation",
};

/**
 * A start time more than a day out is treated as a clock anomaly rather than
 * a scheduled transaction: no flow in this app schedules anything.
 */
const MAX_FUTURE_START_SECONDS = 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function reject(
  reason: SigningPolicyErrorReason,
  opType: ProtectedOpKey,
  message: string,
): ValidationResult {
  return { ok: false, error: new SigningPolicyError(reason, opType, message) };
}

/**
 * Read a decoded operation down to the fields the confirmation UI may show.
 *
 * Returns `null` for any operation whose shape is not recognised, which the
 * caller turns into `extra_fields`. A `changeTrust` missing a usable asset or
 * limit is likewise `null`: an envelope the UI cannot describe is an envelope
 * the UI must not ask the user to approve.
 */
function summarizeOperation(opType: ProtectedOpKey, op: unknown): DecodedOperationSummary | null {
  if (typeof op !== "object" || op === null) return null;
  const candidate = op as { type?: unknown; line?: unknown; limit?: unknown };
  if (typeof candidate.type !== "string") return null;

  const base: DecodedOperationSummary = {
    type: candidate.type,
    assetCode: null,
    assetIssuer: null,
    limit: null,
  };

  if (candidate.type !== CHANGE_TRUST_OPERATION) return base;

  // Only TRUSTLINE is permitted to carry a changeTrust, and only TRUSTLINE is
  // allowed to read these fields off it.
  if (opType !== "TRUSTLINE") return null;

  const line = candidate.line as { code?: unknown; issuer?: unknown } | undefined;
  if (
    typeof line !== "object" ||
    line === null ||
    typeof line.code !== "string" ||
    typeof line.issuer !== "string" ||
    line.code.length === 0 ||
    line.issuer.length === 0
  ) {
    return null;
  }
  const limit = candidate.limit;
  if (typeof limit !== "string" || !/^\d+(\.\d{1,7})?$/.test(limit)) return null;

  return {
    ...base,
    assetCode: line.code,
    assetIssuer: line.issuer,
    limit,
  };
}

/**
 * Validate a raw XDR envelope against the policy for a given op type.
 *
 * Never throws: every failure is a typed {@link SigningPolicyError} in the
 * returned result.
 */
export function validateEnvelope(
  xdr: string,
  opType: ProtectedOpKey,
  options: { passphrase?: string } = {},
): ValidationResult {
  if (typeof xdr !== "string" || xdr.length === 0) {
    return reject("malformed_xdr", opType, "No transaction envelope was provided");
  }

  // 2. Network.
  //
  //    An unsigned envelope does not carry its network anywhere in its
  //    contents — the passphrase is only mixed into the *signature* hash. So
  //    the firewall cannot read the envelope's network and compare it; asking
  //    the decoder for it would be worse than useless, because
  //    `TransactionBuilder.fromXDR` overwrites the decoded passphrase with the
  //    one it was handed, so the check would compare the caller's argument
  //    against itself and never fire.
  //
  //    What *is* checkable is the mistake that would cause a real
  //    cross-network signature: a call site that hands this function a
  //    passphrase other than the configured one. That is caught here. The
  //    residual risk (an envelope built for another network and signed with the
  //    right passphrase) is caught by the network at submission, not here.
  const passphrase = options.passphrase ?? stellarConfig.passphrase;
  if (passphrase !== stellarConfig.passphrase) {
    return reject(
      "network_mismatch",
      opType,
      "Signing policy was evaluated against a network other than the configured one",
    );
  }

  // 1. Decode. A fee-bump envelope wraps an inner transaction and is never
  //    something this app builds, so it is rejected rather than unwrapped.
  let transaction: Transaction;
  try {
    const decoded = TransactionBuilder.fromXDR(
      xdr,
      passphrase,
    ) as Transaction | FeeBumpTransaction;
    if (decoded instanceof FeeBumpTransaction) {
      return reject(
        "malformed_xdr",
        opType,
        "Fee-bump envelopes are not accepted for this operation",
      );
    }
    transaction = decoded as Transaction;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown decode error";
    return reject(
      "malformed_xdr",
      opType,
      `Transaction envelope could not be decoded: ${detail}`,
    );
  }

  // 3. Source must at least be a well-formed account. Whether it equals the
  //    connected wallet is the call site's check — the policy cannot know
  //    which wallet is connected.
  if (!StrKey.isValidEd25519PublicKey(transaction.source)) {
    return reject(
      "source_mismatch",
      opType,
      "Transaction source is not a valid Stellar account",
    );
  }

  // 4. Timebounds. `setTimeout(0)` means "expire immediately" and
  //    `setTimeout(TimeoutInfinite)` means "never expire"; both are anomalies
  //    for a flow whose transaction must be actionable within a few seconds.
  const rawTimeBounds: { minTime: string; maxTime: string } | null | undefined =
    transaction.timeBounds;
  if (rawTimeBounds === null || rawTimeBounds === undefined) {
    return reject(
      "timebound_anomaly",
      opType,
      "Transaction has no expiry; refusing to sign a transaction that never expires",
    );
  }
  const minTime = Number(rawTimeBounds.minTime);
  const maxTime = Number(rawTimeBounds.maxTime);
  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
    return reject("timebound_anomaly", opType, "Transaction timebounds are not numeric");
  }
  // `setTimeout(TimeoutInfinite)` round-trips through XDR as `maxTime: 0`
  // rather than as absent timebounds, so it needs its own branch to produce
  // an accurate message instead of falling into the ordering check below.
  if (maxTime === 0) {
    return reject(
      "timebound_anomaly",
      opType,
      "Transaction never expires; refusing to sign a transaction with no expiry",
    );
  }
  if (minTime > 0 && minTime - nowSeconds() > MAX_FUTURE_START_SECONDS) {
    return reject(
      "timebound_anomaly",
      opType,
      "Transaction start time is implausibly far in the future",
    );
  }
  if (maxTime <= minTime) {
    return reject(
      "timebound_anomaly",
      opType,
      "Transaction expiry is not after its start time",
    );
  }
  if (maxTime < nowSeconds()) {
    return reject("timebound_anomaly", opType, "Transaction has already expired");
  }

  // 5. Fee floor. The protocol minimum is the floor for a 1-op transaction;
  //    a fee below it is rejected at submission, after the user has signed.
  const minimumFee = Number(BASE_FEE);
  const fee = Number(transaction.fee);
  if (!Number.isFinite(fee)) {
    return reject("fee_anomaly", opType, "Transaction fee is not numeric");
  }
  if (fee < minimumFee) {
    return reject(
      "fee_anomaly",
      opType,
      `Transaction fee is below the protocol minimum of ${BASE_FEE} stroops`,
    );
  }

  // 6. Sequence. A real account sequence is a positive int64.
  const sequence = Number(transaction.sequence);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    return reject(
      "sequence_anomaly",
      opType,
      "Transaction sequence number is not a positive integer",
    );
  }

  // 7. Operation set. Exactly one operation, of the permitted name.
  const operations = Array.isArray(transaction.operations) ? transaction.operations : [];
  const allowed = ALLOWED_OPERATIONS[opType];
  if (operations.length !== 1) {
    return reject(
      "unexpected_operation",
      opType,
      `Expected exactly one ${EXPECTED_OPERATION_LABEL[opType]} but found ${operations.length} operations`,
    );
  }
  const operationName = operations[0]?.type;
  if (typeof operationName !== "string" || !allowed.has(operationName)) {
    return reject(
      "unexpected_operation",
      opType,
      `Expected ${EXPECTED_OPERATION_LABEL[opType]} but found "${String(operationName)}"`,
    );
  }

  // 8. Field allow-list.
  const summary = summarizeOperation(opType, operations[0]);
  if (summary === null) {
    return reject(
      "extra_fields",
      opType,
      `Transaction contains fields the ${opLabels[opType]} policy does not expose`,
    );
  }

  return {
    ok: true,
    decoded: {
      type: opType,
      source: transaction.source,
      fee: transaction.fee,
      seq: sequence,
      network: passphrase,
      operations: [summary],
      timebounds: { minTime, maxTime },
    },
  };
}

/**
 * Validate before every wallet prompt.
 *
 * @throws {SigningPolicyError} on policy rejection. Callers catch this to show
 * a policy-specific message instead of a wallet-rejection one.
 */
export function evaluateSigningRequest(xdr: string, opType: ProtectedOpKey): DecodedEnvelope {
  const result = validateEnvelope(xdr, opType);
  if (result.ok) return result.decoded;
  throw result.error;
}

export {
  SigningPolicyError,
  opLabels,
  type DecodedEnvelope,
  type DecodedOperationSummary,
  type ProtectedOpKey,
  type SigningPolicyErrorReason,
  type ValidationResult,
};
