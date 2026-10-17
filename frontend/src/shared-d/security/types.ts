/**
 * Types for the XDR signing policy firewall (#1502, extended for the
 * asset-readiness preflight in #1487).
 *
 * This module is the single definition site for the firewall's types. An
 * earlier revision declared a second, divergent copy of `SigningPolicyError`
 * and `DecodedEnvelope` inside `policy.ts` alongside the ones here; the two
 * sets had incompatible shapes (`operation: ProtectedOp` string union vs
 * `operation: ProtectedOpKey` key union) so `instanceof` narrowing silently
 * failed at every call site. `policy.ts` now imports from here and re-exports.
 *
 * @module
 */

/**
 * Operation identifiers this firewall protects.
 *
 * A closed string union rather than an enum or numeric registry: the values
 * are used as object keys, telemetry labels, and `Record` index types, and a
 * numeric registry would compute to `"0"`/`"1"` when used as a key.
 */
export type ProtectedOpKey =
  | "JOIN"
  | "CREATE"
  | "COMMIT"
  | "REVEAL"
  | "CLAIM"
  | "REFUND"
  | "STAKE"
  | "TRUSTLINE";

/** Every protected op, for exhaustive iteration in tests and UI copy. */
export const PROTECTED_OP_KEYS: readonly ProtectedOpKey[] = [
  "JOIN",
  "CREATE",
  "COMMIT",
  "REVEAL",
  "CLAIM",
  "REFUND",
  "STAKE",
  "TRUSTLINE",
] as const;

/** Human-readable label per protected op, for rejection messages and the UI. */
export const opLabels: Record<ProtectedOpKey, string> = {
  JOIN: "join arena",
  CREATE: "create pool",
  COMMIT: "commit choice",
  REVEAL: "reveal choice",
  CLAIM: "claim reward",
  REFUND: "refund",
  STAKE: "stake",
  TRUSTLINE: "add trustline",
};

/**
 * Why the policy rejected an envelope.
 *
 * A closed, low-cardinality union on purpose: these become telemetry label
 * values, and a free-form `string` would produce unbounded label cardinality
 * in Prometheus.
 */
export type SigningPolicyErrorReason =
  /** The XDR did not decode, or did not decode into the expected shape. */
  | "malformed_xdr"
  /** Envelope network passphrase differs from the configured network. */
  | "network_mismatch"
  /** Timebounds are absent, inverted, or already expired. */
  | "timebound_anomaly"
  /** Fee is below the configured minimum. */
  | "fee_anomaly"
  /** Sequence number is not positive. */
  | "sequence_anomaly"
  /** Source account is not a valid Stellar public key. */
  | "source_mismatch"
  /** The envelope carries an operation the requested op does not allow. */
  | "unexpected_operation"
  /** The op's decoded fields fall outside the allow-list for that op. */
  | "extra_fields";

/**
 * A policy rejection.
 *
 * Distinct from a wallet rejection: the wallet must never be prompted for a
 * request that failed the policy, so the UI can show a policy error without
 * the ambiguity of "the user clicked Cancel".
 */
export class SigningPolicyError extends Error {
  readonly reason: SigningPolicyErrorReason;
  readonly operation: ProtectedOpKey;

  constructor(
    reason: SigningPolicyErrorReason,
    operation: ProtectedOpKey,
    message: string,
  ) {
    super(message);
    this.name = "SigningPolicyError";
    this.reason = reason;
    this.operation = operation;
  }
}

/**
 * A safe, serialisable summary of one decoded operation.
 *
 * The confirmation UI must render from this and never from the raw XDR: the
 * decoded `Operation` instances carry the full transaction graph (including
 * memo text, which can hold user-supplied content), and rendering that into
 * the DOM is how a signing UI ends up displaying something the user did not
 * authorise.
 */
export interface DecodedOperationSummary {
  /** SDK operation name, e.g. `"changeTrust"`, `"payment"`, `"invokeHostFunction"`. */
  type: string;
  /** Credit asset code for `changeTrust`; `null` for every other op. */
  assetCode: string | null;
  /** Credit asset issuer for `changeTrust`; `null` for every other op. */
  assetIssuer: string | null;
  /** Requested trustline limit as a decimal amount string; `null` otherwise. */
  limit: string | null;
}

/** Minimal decoded envelope — only the fields the confirmation UI needs. */
export interface DecodedEnvelope {
  type: ProtectedOpKey;
  source: string;
  fee: string;
  seq: number;
  network: string;
  operations: DecodedOperationSummary[];
  /** `null` timebounds mean "no expiry", which the policy rejects. */
  timebounds: { minTime: number; maxTime: number };
}

/** Either a validated envelope or a typed policy rejection. */
export type ValidationResult =
  | { ok: true; decoded: DecodedEnvelope }
  | { ok: false; error: SigningPolicyError };
