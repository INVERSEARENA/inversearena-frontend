import type { Request } from "express";
import { apiError } from "./apiError";
import type { TransactionRecord } from "../types/payment";

/**
 * Ownership rule for payout/transaction records, fail-closed:
 *  - Admin API-key requests (req.adminId set by requireAdmin) may read anything.
 *  - User JWT requests may only read records whose ownerId matches their id.
 *  - Legacy records with no ownerId are hidden from users (404), never leaked.
 */
export function canAccessTransaction(transaction: TransactionRecord, req: Request): boolean {
  if (req.adminId) return true;
  return transaction.ownerId != null && transaction.ownerId === req.user?.id;
}

/**
 * Throws a 404 (resource-hidden, not "forbidden") when the requester is not
 * allowed to see the record. Use before returning or mutating the record.
 */
export function assertTransactionAccess(transaction: TransactionRecord, req: Request): void {
  if (!canAccessTransaction(transaction, req)) {
    throw apiError(404, "TRANSACTION_NOT_FOUND", `Transaction ${transaction.id} not found`);
  }
}
