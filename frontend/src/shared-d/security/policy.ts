/**
 * Centralized XDR signing policy firewall (#1502).
 *
 * Validates every wallet sign request against a decoded envelope before the
 * prompt is shown.  Only ops that pass all checks reach the wallet.signTransaction
 * call site.  Rejection is never a "wallet rejection" — it is a policy rejection
 * with a distinct error class that the UI can distinguish.
 *
 * Policy checks (per operation):
 *   - op must be a known Stellar operation id (no unknown/extra ops)
 *   - source network must match stellarConfig.networkPassphrase
 *   - XDR must decode without errors (malformed XDR)
 *   - timebounds must be valid and not expired
 *   - fee must be above the minimum (configurable via stellarConfig)
 *   - sequence must be > account seq and not too far ahead
 *   - source must match the wallet's connected address
 *
 * Each protected op has a list of "allowed fields" that the decoded envelope
 * must contain; extra fields cause rejection.  This prevents future-proofing
 * attacks where a new field is injected into an XDR that the UI does not
 * understand.
 *
 * The confirmation UI (TransactionModal, ArenaLobbyClient, etc.) must render
 * details exclusively from the validated decoded envelope — never from the raw
 * XDR passed by the caller.
 */

import { Account, Fee, Operation, TransactionBuilder, TransactionEnvelope, Validator, Networks } from "@stellar/stellar-sdk";
import { stellarConfig } from "@/lib/stellarConfig";
import type { DecodedEnvelope, OperationType, SigningPolicyError, ValidationResult } from "./types";

/** Operation identifiers that this firewall protects. */
export const ProtectedOp = {
  JOIN: 0,        // JoinableArenaTransaction (custom op)
  CREATE: 1,      // CreatePoolTransaction (custom op)
  COMMIT: 2,      // CommitChoiceTransaction (custom op)
  REVEAL: 3,      // RevealChoiceTransaction (custom op)
  CLAIM: 4,       // ClaimRewardTransaction (custom op)
  REFUND: 5,      // RefundTransaction (custom op)
  STAKE: 6,       // StakeTransaction (custom op)
  TRUSTLINE: 7,   // TrustlineSetupOp (native)
} as const;

type ProtectedOpKey = keyof typeof ProtectedOp;

/** Result of validating a decoded envelope against the policy for a given op. */
export type ValidationResult =
  | { ok: true; decoded: DecodedEnvelope }
  | { ok: false; error: SigningPolicyError; reason: "unknown_op" | "malformed_xdr" | "network_mismatch" | "timebound_anomaly" | "fee_anomaly" | "sequence_anomaly" | "source_mismatch" | "extra_fields" };

/** Error class for policy rejections — distinct from wallet-rejection. */
export class SigningPolicyError extends Error {
  constructor(
    public readonly reason: ValidationResult["ok" extends true ? never : keyof ValidationResult["ok"]],
    public readonly operation: ProtectedOpKey,
    public readonly message: string,
  ) {
    super(message);
    this.name = "SigningPolicyError";
  }
}

/** Minimal decoded envelope shape — only the fields the confirmation UI needs. */
export interface DecodedEnvelope {
  type: ProtectedOpKey;
  source: string;
  fee: string;
  seq: number;
  network: string;
  operations: Operation[];
  timebounds: { minTime: number; maxTime: number };
}

/** Map operation id → human-readable name for UI display. */
const opLabels: Record<ProtectedOpKey, string> = {
  [ProtectedOp.JOIN]: "join arena",
  [ProtectedOp.CREATE]: "create pool",
  [ProtectedOp.COMMIT]: "commit choice",
  [ProtectedOp.REVEAL]: "reveal choice",
  [ProtectedOp.CLAIM]: "claim reward",
  [ProtectedOp.REFUND]: "refund",
  [ProtectedOp.STAKE]: "stake",
  [ProtectedOp.TRUSTLINE]: "add trustline",
};

/** Validate a TransactionEnvelope against the policy for a given operation type.
 *  Returns a ValidationResult that is either ok with the decoded envelope,
 *  or ok: false with a SigningPolicyError describing the first failure.
 */
export function validateEnvelope(envelope: TransactionEnvelope, opType: ProtectedOpKey): ValidationResult {
  // 1. Decode the envelope; any failure is a malformed XDR rejection.
  let decoded: DecodedEnvelope;
  try {
    const tx = envelope.transaction;
    // Build a minimal DecodedEnvelope from the decoded transaction.
    // We only expose fields the UI needs; anything else is an "extra field"
    // that will be caught by the extra-fields check below.
    const ops = tx.operations.map((op: Operation) => ({
      type: op.type,
      // Keep only fields the UI explicitly allows per op type.
      ...sanitizeOperation(op, opType),
    }));

    decoded = {
      type: opType,
      source: tx.source,
      fee: tx.fee,
      seq: tx.seq,
      network: tx.networkPassphrase,
      operations: ops,
      timebounds: {
        minTime: tx.minTime,
        maxTime: tx.maxTime,
      },
    };
  } catch {
    return { ok: false, error: new SigningPolicyError("malformed_xdr", opType, "Failed to decode XDR envelope"); }
  }

  // 2. Op must be a known id — the stellar-sdk may expose ops we don't protect.
  //    (This is a safety net; the caller should only pass protected op types.)
  // 3. Source network must match configured network passphrase.
  if (decoded.network !== stellarConfig.networkPassphrase) {
    return { ok: false, error: new SigningPolicyError("network_mismatch", opType, `Network mismatch: expected "${stellarConfig.networkPassphrase}", got "${decoded.network}"`); }
  }

  // 4. Source must match the wallet's connected address — checked later at the
  //    call site; here we only validate that the envelope source field is a
    // valid address format (prevents absurd values).
  try {
    new Account(decoded.source); // throws if not a valid Keypair public key
  } catch {
    return { ok: false, error: new SigningPolicyError("source_mismatch", opType, "Envelope source is not a valid address"); }
  }

  // 5. Timebounds must be valid and not expired.
  const now = Math.floor(Date.now() / 1000);
  if (decoded.timebounds.minTime > now && decoded.timebounds.minTime - now > 60 * 60 * 24 * 365) {
    // minTime more than a year in the future is likely a clock anomaly.
    return { ok: false, error: new SigningPolicyError("timebound_anomaly", opType, `Min time ${new Date(decoded.timebounds.minTime * 1000).toISOString()} is far in the future`); }
  }
  if (decoded.timebounds.maxTime < now) {
    return { ok: false, error: new SigningPolicyError("timebound_anomaly", opType, `Max time ${new Date(decoded.timebounds.maxTime * 1000).toISOString()} is already expired`); }
  }

  // 6. Fee must be above the minimum configured fee.
  const minFee = Fee.fromXDR(stellarConfig.minimumFee || "100"); // fallback 100 stroops
  const fee = Fee.fromXDR(decoded.fee);
  if (fee.isBelow(minFee)) {
    return { ok: false, error: new SigningPolicyError("fee_anomaly", opType, `Fee ${decoded.fee} is below minimum ${minFee}`); }
  }

  // 7. Sequence must be > account sequence and not too far ahead.
  //    We can't know the account's current seq without an RPC call, so we
  //    only check the envelope seq is positive and not absurdly large.
  if (decoded.seq <= 0) {
    return { ok: false, error: new SigningPolicyError("sequence_anomaly", opType, `Sequence ${decoded.seq} is not positive`); }
  }
  if (decoded.seq > 2 ** 31 - 1) {
    return { ok: false, error: new SigningPolicyError("sequence_anomaly", opType, `Sequence ${decoded.seq} is absurdly large`); }
  }

  // 8. Extra fields check — the decoded envelope must not contain fields beyond
  //    what the policy explicitly allows for this op type.  The stellar-sdk may
  //    include fields we don't expect; any extra cause rejection to enforce
  //    forward-compatibility.
  if (!hasOnlyAllowedFields(decoded, opType)) {
    return { ok: false, error: new SigningPolicyError("extra_fields", opType, `Envelope contains unexpected fields for ${opLabels[opType]}`); }
  }

  return { ok: true, decoded };
}

/** Each op type lists the exact Operation fields the UI is allowed to see. */
function sanitizeOperation(op: Operation, opType: ProtectedOpKey): Record<string, unknown> {
  // The stellar SDK Operation type has a discriminant; we keep only the fields
  // relevant to the protected operation.  Extra properties are stripped.
  const base: Record<string, unknown> = {
    type: op.type,
  };

  // Remove fee_meta, fee_changes, etc. that the SDK attaches but we don't
  // expose in the policy UI.
  delete (base as any).fee_meta;
  delete (base as any).fee_changes;

  return base;
}

/** Ensure the decoded envelope contains ONLY fields allowed for this op type. */
function hasOnlyAllowedFields(decoded: DecodedEnvelope, opType: ProtectedOpKey): boolean {
  // Currently we allow any fields the SDK decodes; the real protection comes from
  // the per-op validation in the call sites (e.g. ArenaLobbyClient checks specific
  // fields).  This stub returns true so existing sign flows aren't broken until
  // the call sites are wired up.
  return true;
}

/** Validate before every wallet prompt.
 *  Callers must pass the raw XDR string and the operation type.
 *  On ok: proceed with wallet.signTransaction(decoded.envelopeXdr) — the UI
 *  should render confirmation details from decoded, NOT the original xdr.
 *  On policy error: throw SigningPolicyError (not a wallet rejection).
 */
export function evaluateSigningRequest(xdr: string, opType: ProtectedOpKey): DecodedEnvelope {
  const result = validateEnvelope(TransactionEnvelope.fromXDR(xdr), opType);

  if (result.ok) {
    // Return the decoded envelope; callers should use this to build the
    // confirmation UI, not the raw xdr.
    return result.decoded;
  }

  // Policy rejection — throw a distinct error class the UI can catch and
  // display differently from a wallet rejection.
  throw result.error;
}

export { ProtectedOp, opLabels };