export type PaymentStatus =
  | "built"
  | "queued"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed"
  | "dead";

export interface TransactionRecord {
  id: string;
  payoutId: string;
  idempotencyKey: string;
  sourceAccount: string;
  destinationAccount: string;
  asset: "XLM" | "USDC";
  amountStroops: string;
  nonce: number;
  status: PaymentStatus;
  unsignedXdr: string;
  signedXdr?: string | null;
  txHash?: string | null;
  errorMessage?: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt?: Date | null;
  replacesTransactionId?: string | null;
  replacedByTransactionId?: string | null;
  /** Admin API key id or user id that created this payout (null for legacy rows). */
  ownerId?: string | null;
  /**
   * Settlement breakdown (#1407), in display-unit XLM/USDC (not stroops),
   * populated only for payouts created from a round settlement — see
   * domain/roundResolution and domain/settlement calculations.
   * Null/undefined for ad-hoc admin-created payouts, which never had this
   * context computed.
   */
  principal?: number | null;
  yieldAmount?: number | null;
  platformFee?: number | null;
  dust?: number | null;
}

export interface PayoutBreakdown {
  principal: number;
  yieldAmount: number;
  platformFee: number;
  dust: number;
}

export interface CreatePayoutRequest {
  payoutId: string;
  destinationAccount: string;
  amount: string;
  asset: "XLM" | "USDC";
  idempotencyKey: string;
  breakdown?: PayoutBreakdown;
}

export interface BuildPayoutResult {
  mode: "build_only" | "queued";
  transaction: TransactionRecord;
  unsignedXdr: string;
}

export interface SubmitResult {
  transaction: TransactionRecord;
  submitted: boolean;
}

