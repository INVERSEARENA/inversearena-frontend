import type { PaymentStatus, TransactionRecord } from "../types/payment";

export interface TransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null>;
  /**
   * Look a payout up by its business identifier rather than the caller-supplied
   * idempotency key, so a retry that generates a fresh key cannot mint a second
   * payout for the same prize (#1353).
   */
  findByPayoutId(payoutId: string): Promise<TransactionRecord | null>;
  findById(id: string): Promise<TransactionRecord | null>;
  reserveNextNonce(sourceAccount: string): Promise<number>;
  insert(record: TransactionRecord): Promise<void>;
  update(
    id: string,
    patch: TransactionPatch
  ): Promise<TransactionRecord>;
  listByStatus(statuses: PaymentStatus[], limit: number): Promise<TransactionRecord[]>;

  /**
   * Payouts addressed to one wallet, newest first, keyset-paginated (#1489).
   *
   * The claim inbox needs three things `listByStatus` cannot give it, and all
   * three were missing rather than merely unused:
   *
   * 1. **An owner filter.** `listByStatus` filters on status alone, so the only
   *    way to find a wallet's payouts is to fetch every payout in those
   *    statuses and filter in memory — which returns another wallet's amounts
   *    before discarding them, and does not scale past a single page.
   * 2. **Descending order.** The inbox is a to-do list; `listByStatus` sorts
   *    ascending (oldest first), which is a work queue's ordering.
   * 3. **A cursor.** Stable pagination over a list that grows as claims are
   *    created needs keyset pagination on `(updatedAt, id)`.
   *
   * @param cursor `updatedAt`/`id` of the last item already returned. Rows
   *   strictly *after* it in sort order are returned, so an item inserted
   *   while a client is paging lands ahead of the cursor and is never
   *   duplicated or skipped.
   */
  listByDestination(
    destinationAccount: string,
    limit: number,
    cursor?: { updatedAt: Date; id: string } | null,
  ): Promise<TransactionRecord[]>;
}

export type TransactionPatch = Partial<
  Omit<TransactionRecord, "id" | "createdAt" | "payoutId" | "idempotencyKey" | "sourceAccount" | "nonce">
>;

