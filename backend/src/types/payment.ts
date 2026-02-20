export type PaymentStatus =
  | "built"
  | "queued"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed";

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
}

export interface CreatePayoutRequest {
  payoutId: string;
  destinationAccount: string;
  amount: string;
  asset: "XLM" | "USDC";
  idempotencyKey: string;
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

