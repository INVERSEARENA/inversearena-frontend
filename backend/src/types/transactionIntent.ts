/**
 * A "transaction intent" tracks a user-wallet-signed action (create pool,
 * stake, unstake, join arena, commit/reveal choice, claim winnings) from the
 * moment its unsigned XDR is built through wallet signing and on-chain
 * submission, so a wallet rejection or an expired signing window can be
 * resumed against the same record instead of silently discarding the
 * original envelope and starting over untracked (#1381).
 *
 * Deliberately separate from `payment.ts`'s `TransactionRecord`: that type
 * tracks server-signed payouts (a different actor, a different state
 * machine — see `paymentService.ts`). An intent is never signed by this
 * backend; it only tracks state the user's own wallet produces.
 */
export type IntentStatus =
  | "built"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired";

export type IntentKind =
  | "create_pool"
  | "stake"
  | "unstake"
  | "join_arena"
  | "commit_choice"
  | "reveal_choice"
  | "claim";

export interface TransactionIntentRecord {
  id: string;
  /** Caller-supplied dedup key, stable across retries of the same logical action. */
  idempotencyKey: string;
  kind: IntentKind;
  /** Wallet public key that will sign this intent; also the ownership boundary. */
  ownerWallet: string;
  status: IntentStatus;
  unsignedXdr: string;
  signedXdr?: string | null;
  txHash?: string | null;
  errorMessage?: string | null;
  attempts: number;
  /** Attempts at wallet signing, tracked separately from submission attempts. */
  signAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  /** Server-computed: `createdAt` + the configured TTL (#1381). */
  expiresAt: Date;
  confirmedAt?: Date | null;
}

export interface CreateIntentRequest {
  idempotencyKey: string;
  kind: IntentKind;
  unsignedXdr: string;
}

export interface CreateIntentResult {
  /** "created" for a fresh intent; "resumed" when an existing, unexpired intent matched the idempotency key. */
  mode: "created" | "resumed";
  intent: TransactionIntentRecord;
}
