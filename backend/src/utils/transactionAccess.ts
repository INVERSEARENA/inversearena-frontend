import type { Request } from "express";
import { apiError, type HttpError } from "./apiError";
import { logger } from "./logger";
import { transactionAccessDecisionsTotal } from "./metrics";
import type { TransactionRecord } from "../types/payment";

/**
 * Transaction/payout status access policy (#1454). See
 * docs/design/transaction-access.md for the full design note.
 *
 * Ownership rule, fail-closed:
 *  - Admin API-key requests (req.adminId set by requireAdmin) may read anything.
 *  - User JWT requests may only read records whose ownerId matches their id.
 *  - Legacy records with no ownerId are hidden from users (404), never leaked.
 *
 * Enumeration resistance: every denial — absent, foreign, legacy, or an
 * unauthenticated caller — produces the *same* HttpError (status, code and
 * message are all derived from the requested id only, never from the stored
 * record). The real reason is recorded server-side in logs/metrics only.
 */

export const TRANSACTION_NOT_FOUND_CODE = "TRANSACTION_NOT_FOUND";

/** Why access was granted or denied. Never sent to the client. */
export type TransactionAccessReason =
  | "admin"
  | "owner"
  | "absent"
  | "unauthenticated"
  | "foreign_owner"
  | "legacy_unowned";

export type TransactionAccessDecision =
  | { allowed: true; reason: "admin" | "owner" }
  | { allowed: false; reason: Exclude<TransactionAccessReason, "admin" | "owner"> };

/** The caller identity the policy needs; decoupled from Express for testing. */
export interface TransactionPrincipal {
  adminId?: string | null;
  userId?: string | null;
}

export interface TransactionLookup {
  findById(id: string): Promise<TransactionRecord | null>;
}

export function principalFromRequest(req: Request): TransactionPrincipal {
  return { adminId: req.adminId ?? null, userId: req.user?.id ?? null };
}

/** Pure policy decision for one (possibly absent) record. */
export function evaluateTransactionAccess(
  transaction: TransactionRecord | null | undefined,
  principal: TransactionPrincipal,
): TransactionAccessDecision {
  if (!transaction) return { allowed: false, reason: "absent" };
  if (principal.adminId) return { allowed: true, reason: "admin" };
  if (!principal.userId) return { allowed: false, reason: "unauthenticated" };
  if (transaction.ownerId == null) return { allowed: false, reason: "legacy_unowned" };
  if (transaction.ownerId !== principal.userId) return { allowed: false, reason: "foreign_owner" };
  return { allowed: true, reason: "owner" };
}

export function canAccessTransaction(transaction: TransactionRecord, req: Request): boolean {
  return evaluateTransactionAccess(transaction, principalFromRequest(req)).allowed;
}

/**
 * The single opaque "not found" error. It depends only on the id the caller
 * supplied, so absent and unauthorized records are byte-for-byte identical.
 */
export function transactionNotFound(requestedId: string): HttpError {
  return apiError(404, TRANSACTION_NOT_FOUND_CODE, `Transaction ${requestedId} not found`);
}

/**
 * Throws the opaque 404 when the requester is not allowed to see the record.
 * Use before returning or mutating the record.
 */
export function assertTransactionAccess(transaction: TransactionRecord, req: Request): void {
  if (!canAccessTransaction(transaction, req)) {
    throw transactionNotFound(transaction.id);
  }
}

function recordDecision(
  operation: string,
  requestedId: string,
  decision: TransactionAccessDecision,
  principal: TransactionPrincipal,
  startedAt: number,
): void {
  const outcome = decision.allowed ? "allowed" : "denied";
  transactionAccessDecisionsTotal.inc({ operation, outcome, reason: decision.reason });
  const entry = {
    event: "transaction_access",
    operation,
    outcome,
    reason: decision.reason,
    transactionId: requestedId,
    principal: principal.adminId ? "admin" : principal.userId ? "user" : "anonymous",
    latencyMs: Date.now() - startedAt,
  };
  // Foreign-owner hits are the enumeration signal worth alerting on.
  if (decision.reason === "foreign_owner") logger.warn(entry, "transaction access denied");
  else logger.debug(entry, "transaction access decision");
}

/**
 * Load a transaction and enforce the access policy in one step. Returns the
 * record, or throws the opaque 404. Repository errors propagate unchanged so
 * the error handler maps them to a generic 5xx (never to a 404, which would
 * let a caller distinguish "store down" from "not yours").
 */
export async function loadAccessibleTransaction(
  repo: TransactionLookup,
  requestedId: string,
  req: Request,
  operation: string,
): Promise<TransactionRecord> {
  const startedAt = Date.now();
  const principal = principalFromRequest(req);
  const transaction = await repo.findById(requestedId);
  const decision = evaluateTransactionAccess(transaction, principal);
  recordDecision(operation, requestedId, decision, principal, startedAt);
  if (!decision.allowed || !transaction) throw transactionNotFound(requestedId);
  return transaction;
}

/** Drop records the requester may not see (e.g. siblings in a payout timeline). */
export function filterAccessibleTransactions(
  records: readonly TransactionRecord[],
  req: Request,
): TransactionRecord[] {
  const principal = principalFromRequest(req);
  return records.filter((record) => evaluateTransactionAccess(record, principal).allowed);
}
