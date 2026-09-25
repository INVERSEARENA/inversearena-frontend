/** Operation types protected by the XDR signing policy firewall. */
export type ProtectedOp =
  | "JOIN"
  | "CREATE"
  | "COMMIT"
  | "REVEAL"
  | "CLAIM"
  | "REFUND"
  | "STAKE"
  | "TRUSTLINE";

/** Error reasons emitted by the policy firewall — distinct from wallet rejection. */
export type SigningPolicyErrorReason =
  | "unknown_op"
  | "malformed_xdr"
  | "network_mismatch"
  | "timebound_anomaly"
  | "fee_anomaly"
  | "sequence_anomaly"
  | "source_mismatch"
  | "extra_fields";

/** A policy rejection — the wallet must NOT present a "confirm/cancel" prompt;
 *  the UI must show a policy-error message instead. */
export class SigningPolicyError extends Error {
  readonly reason: SigningPolicyErrorReason;
  readonly operation: ProtectedOp;
  constructor(reason: SigningPolicyErrorReason, operation: ProtectedOp, message: string) {
    super(message);
    this.reason = reason;
    this.operation = operation;
    this.name = "SigningPolicyError";
  }
}

/** Decoded envelope shape returned by evaluateSigningRequest — the confirmation
 *  UI must render its details from this object, never from the raw XDR. */
export interface DecodedEnvelope {
  type: ProtectedOp;
  source: string;
  fee: string;
  seq: number;
  network: string;
  operations: Operation[];
  timebounds: { minTime: number; maxTime: number };
}

/** Result of evaluateSigningRequest — either the decoded envelope (ok) or a
 *  thrown SigningPolicyError (policy rejection). */
export type EvaluationResult =
  | { success: true; decoded: DecodedEnvelope }
  | { success: false; error: SigningPolicyError };