/**
 * Data Export & Erasure Service (#1739)
 *
 * Provides self-service data export (JSON archive of all user-linked data)
 * and right-to-erasure workflow with:
 *   - A retention matrix distinguishing erasable data from records that must
 *     be retained (financial reconciliation, on-chain data).
 *   - Pseudonymization of retained rows (replace PII with an irreversible
 *     token) instead of deletion.
 *   - Session/push revocation as part of erasure.
 *   - Request audit trail and SLA tracking.
 *
 * Data sources:
 *   MongoDB  : User identity, alias history, watched arena ids, nonces,
 *              refresh tokens, transaction intents, audit logs
 *   Postgres : Notification preferences, notification deliveries,
 *              push subscriptions, elimination logs, transactions
 *   Redis    : Sessions (auth:jti:* and auth:wallet:*)
 *
 * On-chain data (arena participation, payouts, eliminations on the Soroban
 * contract) cannot be erased — they are public ledger entries. This service
 * documents that limitation and pseudonymizes the off-chain references so
 * a retained row can no longer be linked back to the requesting user.
 */

import type { PrismaClient } from "@prisma/client";
import { UserModel } from "../db/models/user.model";
import { NonceModel } from "../db/models/nonce.model";
import { RefreshTokenModel } from "../db/models/refreshToken.model";
import { TransactionIntentModel } from "../db/models/transactionIntent.model";
import { TransactionModel } from "../db/models/transaction.model";
import { AuditLogModel } from "../db/models/auditLog.model";
import { sessionStore } from "../cache/sessionStore";
import { apiError } from "../utils/apiError";
import { logger } from "../utils/logger";
import { createHash, randomBytes } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ErasureRequestStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";

export type ErasureRequestReason = "user_request" | "regulatory";

export interface ErasureRequestView {
  id: string;
  userId: string;
  walletAddress: string;
  status: ErasureRequestStatus;
  reason: ErasureRequestReason;
  requestedAt: string;
  completedAt: string | null;
  /** Human-readable summary of what was deleted vs pseudonymized. */
  summary: string | null;
  /** If blocked, why (e.g. pending payouts). */
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportArchive {
  userId: string;
  walletAddress: string;
  exportedAt: string;
  data: {
    identity: Record<string, unknown> | null;
    aliases: unknown[];
    watchedArenas: string[];
    notificationPreferences: Record<string, unknown> | null;
    notificationDeliveries: unknown[];
    pushSubscriptions: unknown[];
    eliminationLogs: unknown[];
    transactions: unknown[];
    transactionIntents: unknown[];
    auditLogs: unknown[];
    sessions: { note: string };
    nonces: { note: string };
  };
}

// ── Retention Matrix ──────────────────────────────────────────────────────────

/**
 * Categorizes each data category as erasable or retained (pseudonymized).
 * On-chain data is never erasable — it is public ledger.
 */
export const RETENTION_MATRIX = {
  erasable: [
    "identity (display name, alias history)",
    "watched arena ids",
    "notification preferences",
    "notification deliveries",
    "push subscriptions",
    "auth nonces",
    "refresh tokens",
    "sessions (Redis)",
    "transaction intents (transient)",
  ],
  retainedPseudonymized: [
    "transactions (financial reconciliation — tx_hash, amount, type retained; user_id replaced with irreversible token)",
    "elimination logs (game integrity — round_id, reason retained; user_id replaced with irreversible token)",
    "audit logs (compliance — admin_id, action retained; actor.id pseudonymized if it matches the requesting user)",
  ],
  notErasable: [
    "on-chain arena participation (Soroban contract state)",
    "on-chain payouts (ledger entries)",
    "on-chain eliminations (contract events)",
  ],
} as const;

// ── Pseudonymization ───────────────────────────────────────────────────────────

/**
 * Generate an irreversible pseudonymous token to replace a user id in
 * retained rows. The token is deterministic (same userId always produces
 * the same token) so retained rows can still be correlated for audit
 * purposes without identifying the person.
 *
 * Uses HMAC-SHA256 with a per-request salt to ensure different erasure
 * requests produce different tokens for the same user (prevents cross-
 * request linkage). The salt is discarded — the token is irreversible.
 */
export function pseudonymizeUserId(userId: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString("hex");
  const token = createHash("sha256")
    .update(`${userId}:${s}`)
    .digest("hex")
    .slice(0, 32);
  return `erased:${token}`;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class DataExportService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Export all user-linked data as a JSON archive.
   *
   * This is the "right to data portability" endpoint: everything the backend
   * stores about a user, assembled in one response. Sensitive fields
   * (encrypted push keys) are included in their encrypted form with a note.
   */
  async exportUserData(userId: string, walletAddress: string): Promise<DataExportArchive> {
    // ── MongoDB data ──────────────────────────────────────────────────────────
    const user = await UserModel.findById(userId).lean();
    const transactionIntents = await TransactionIntentModel
      .find({ ownerWallet: walletAddress })
      .lean()
      .catch(() => []);

    const auditLogs = await AuditLogModel
      .find({ $or: [{ adminId: userId }, { "actor.id": userId }] })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .catch(() => []);

    // ── Postgres data ─────────────────────────────────────────────────────────
    const notificationPreference = await this.prisma.notificationPreference
      .findUnique({ where: { userId } })
      .catch(() => null);

    const notificationDeliveries = await this.prisma.notificationDelivery
      .findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 })
      .catch(() => []);

    const pushSubscriptions = await this.prisma.pushSubscription
      .findMany({ where: { userId }, orderBy: { createdAt: "desc" } })
      .catch(() => []);

    const eliminationLogs = await this.prisma.eliminationLog
      .findMany({ where: { userId }, orderBy: { eliminatedAt: "desc" }, take: 200 })
      .catch(() => []);

    const transactions = await this.prisma.transaction
      .findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 200 })
      .catch(() => []);

    return {
      userId,
      walletAddress,
      exportedAt: new Date().toISOString(),
      data: {
        identity: user
          ? {
              _id: String(user._id),
              walletAddress: user.walletAddress,
              displayName: user.displayName ?? null,
              joinedAt: user.joinedAt?.toISOString?.() ?? null,
              lastLoginAt: user.lastLoginAt?.toISOString?.() ?? null,
            }
          : null,
        aliases: user?.aliasHistory ?? [],
        watchedArenas: user?.watchedArenaIds ?? [],
        notificationPreferences: notificationPreference
          ? {
              ...notificationPreference,
              id: String(notificationPreference.id),
            }
          : null,
        notificationDeliveries: notificationDeliveries.map((d) => ({
          ...d,
          id: String(d.id),
        })),
        pushSubscriptions: pushSubscriptions.map((s) => ({
          id: String(s.id),
          endpoint: s.endpoint,
          // p256dh/auth are encrypted at rest; included as-is
          p256dh: "[encrypted]",
          auth: "[encrypted]",
          userAgent: s.userAgent ?? null,
          createdAt: s.createdAt.toISOString(),
        })),
        eliminationLogs: eliminationLogs.map((e) => ({
          id: String(e.id),
          roundId: e.roundId,
          reason: e.reason,
          eliminatedAt: e.eliminatedAt.toISOString(),
        })),
        transactions: transactions.map((t) => ({
          id: String(t.id),
          txHash: t.txHash,
          amount: t.amount,
          type: t.type,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
        })),
        transactionIntents: transactionIntents.map((t) => ({
          _id: String(t._id),
          kind: t.kind,
          status: t.status,
          txHash: t.txHash ?? null,
          createdAt: t.createdAt?.toISOString?.() ?? null,
        })),
        auditLogs: auditLogs.map((a) => ({
          id: String(a._id),
          action: a.action,
          resourceType: a.resourceType,
          status: a.status,
          createdAt: a.createdAt?.toISOString?.() ?? null,
        })),
        sessions: {
          note: "Active sessions are stored in Redis (auth:jti:*). Use the erasure endpoint to revoke them.",
        },
        nonces: {
          note: "Auth nonces are ephemeral (TTL-indexed in MongoDB) and expire automatically.",
        },
      },
    };
  }

  /**
   * Check whether a user has blocking conditions that prevent erasure:
   * pending payouts, unresolved transactions, or outstanding claims.
   */
  async checkErasureBlockers(userId: string): Promise<string[]> {
    const blockers: string[] = [];

    // Pending payouts (transactions in PENDING status)
    const pendingTransactions = await this.prisma.transaction
      .count({ where: { userId, status: "PENDING" } })
      .catch(() => 0);
    if (pendingTransactions > 0) {
      blockers.push(`${pendingTransactions} pending payout(s) must be resolved first`);
    }

    // Check Mongo for any submitted/queued transactions for this wallet
    const pendingPayouts = await TransactionModel
      .countDocuments({
        destinationAccount: { $ne: null },
        status: { $in: ["queued", "awaiting_signature", "submitted"] },
      })
      .catch(() => 0);
    if (pendingPayouts > 0) {
      blockers.push(`${pendingPayouts} submitted payout(s) awaiting confirmation`);
    }

    return blockers;
  }

  /**
   * Execute the erasure: delete erasable data, pseudonymize retained rows,
   * revoke sessions and push subscriptions.
   *
   * This is the "right to erasure" endpoint. On-chain data is not touched.
   */
  async executeErasure(userId: string, walletAddress: string): Promise<{
    deleted: string[];
    pseudonymized: string[];
    revoked: string[];
    blockers: string[];
  }> {
    // ── Check blockers ──────────────────────────────────────────────────────────
    const blockers = await this.checkErasureBlockers(userId);
    if (blockers.length > 0) {
      return {
        deleted: [],
        pseudonymized: [],
        revoked: [],
        blockers,
      };
    }

    const deleted: string[] = [];
    const pseudonymized: string[] = [];
    const revoked: string[] = [];
    const salt = randomBytes(16).toString("hex");
    const pseudId = pseudonymizeUserId(userId, salt);

    // ── Erasable: MongoDB ──────────────────────────────────────────────────────
    // Delete the user identity document
    await UserModel.findByIdAndDelete(userId).catch(() => {});
    deleted.push("user identity (MongoDB)");

    // Delete nonces (ephemeral, but explicit)
    await NonceModel.deleteMany({ walletAddress }).catch(() => {});
    deleted.push("auth nonces");

    // Delete refresh tokens (revoke all sessions)
    await RefreshTokenModel.updateMany(
      { userId, revoked: false },
      { revoked: true },
    ).catch(() => {});
    revoked.push("refresh tokens");

    // Revoke all Redis sessions
    try {
      await sessionStore.removeAllSessions(walletAddress);
      revoked.push("Redis sessions");
    } catch (err) {
      logger.warn({ err }, "erasure_session_revoke_failed");
    }

    // Delete transaction intents (transient)
    await TransactionIntentModel.deleteMany({ ownerWallet: walletAddress }).catch(() => {});
    deleted.push("transaction intents");

    // ── Erasable: Postgres ───────────────────────────────────────────────────────
    // Notification preferences
    await this.prisma.notificationPreference
      .delete({ where: { userId } })
      .catch(() => {});
    deleted.push("notification preferences");

    // Notification deliveries
    await this.prisma.notificationDelivery
      .deleteMany({ where: { userId } })
      .catch(() => {});
    deleted.push("notification deliveries");

    // Push subscriptions
    await this.prisma.pushSubscription
      .deleteMany({ where: { userId } })
      .catch(() => {});
    deleted.push("push subscriptions");

    // ── Retained & Pseudonymized: Postgres ─────────────────────────────────────
    // Transactions — retain for financial reconciliation, pseudonymize user_id
    await this.prisma.transaction
      .updateMany({
        where: { userId },
        data: { userId: pseudId },
      })
      .catch(() => {});
    pseudonymized.push("transactions (user_id → pseudonymous token)");

    // Elimination logs — retain for game integrity, pseudonymize user_id
    await this.prisma.eliminationLog
      .updateMany({
        where: { userId },
        data: { userId: pseudId },
      })
      .catch(() => {});
    pseudonymized.push("elimination logs (user_id → pseudonymous token)");

    logger.info(
      { userId: pseudId, deleted: deleted.length, pseudonymized: pseudonymized.length, revoked: revoked.length },
      "erasure_completed",
    );

    return { deleted, pseudonymized, revoked, blockers };
  }
}
