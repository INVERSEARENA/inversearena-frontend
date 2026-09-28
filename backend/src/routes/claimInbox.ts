/**
 * Claim and refund inbox route (#1489), mounted under /api/users from
 * routes/users.ts as GET /api/users/me/claim-inbox.
 *
 * Kept in its own module for the same reason routes/watchlist.ts is: this
 * router is imported by routes/users.ts, and that file already imports
 * services with pre-existing broken metric imports. A broken import anywhere
 * in the graph fails `tsc` and takes the tests of every other user route with
 * it, so the inbox is reachable without importing the broken ones.
 */

import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { apiError } from "../utils/apiError";
import { ClaimInboxService, type ClaimInboxRefundCandidate } from "../services/claimInboxService";
import { CancellationRecoveryService } from "../services/cancellationRecoveryService";
import { getStellarConfig } from "../config/stellarConfig";
import { maskWalletAddress } from "../utils/logger";
import { verifyArenasOnChain } from "../services/claimInboxVerifier";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { logger } from "../utils/logger";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const ClaimInboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
});

/**
 * Display units to stroops, for a refund amount that cancellation recovery
 * stores as a float.
 *
 * `Math.floor` matches the frontend builders, so the figure the inbox quotes is
 * the figure the refund transaction will actually carry. Rounding up would
 * quote more than is paid; rounding down would understate the entitlement.
 */
function refundAmountToStroops(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  return Math.floor(amount * 10_000_000).toString();
}

export function createClaimInboxRouter(
  prisma: PrismaClient,
  authMiddleware: RequestHandler,
  transactions: TransactionRepository,
): Router {
  const router = Router();
  const cancellation = new CancellationRecoveryService(prisma);
  // Resolved once here, not per request: this validates the Stellar env, so it
  // belongs at boot where a bad `ASSET_ISSUERS` should fail loudly, rather than
  // turning into a 500 on the first wallet that asks for its inbox.
  const { assetIssuers } = getStellarConfig();

  /**
   * Read refundable stakes for one wallet out of cancellation recovery.
   *
   * `getArenaRecovery` is per-arena and returns `null` for an arena that was
   * not cancelled, so finding a wallet's positions means asking about the
   * arenas it participated in. Participation is read from the elimination log
   * and round player choices — the same derivation the per-arena endpoint uses,
   * so the two cannot disagree about who is owed a refund.
   */
  const findRefunds = async (walletAddress: string): Promise<ClaimInboxRefundCandidate[]> => {
      const rows = await prisma.round.findMany({
        where: {
          OR: [
            { eliminationLogs: { some: { userId: walletAddress } } },
            { allActivePlayerIds: { has: walletAddress } },
          ],
        },
        select: { arenaId: true },
        distinct: ["arenaId"],
        take: 50,
      });

      const candidates: ClaimInboxRefundCandidate[] = [];
      for (const row of rows) {
        const recovery = await cancellation.getArenaRecovery(row.arenaId);
        if (!recovery) continue;
        const mine = recovery.participants.filter(
          (p) => p.walletAddress === walletAddress,
        );
        for (const participant of mine) {
          candidates.push({
            arenaId: participant.arenaId,
            arenaName: participant.arenaName,
            walletAddress: participant.walletAddress,
            // Cancellation recovery denominates refunds in XLM.
            assetCode: "XLM",
            refundAmountStroops: refundAmountToStroops(participant.refundAmount),
            recoveryStatus: participant.recoveryStatus,
            txHash: participant.txHash ?? null,
            confirmedAt: participant.confirmedAt ?? null,
            updatedAt: participant.submittedAt ? new Date(participant.submittedAt) : null,
          });
        }
      }
      return candidates;
  };

  const service = new ClaimInboxService({
    prisma,
    transactions,
    verifyArenas: verifyArenasOnChain,
    findRefunds,
    assetIssuers,
  });

  /**
   * GET /api/users/me/claim-inbox
   *
   * Wallet-scoped, cursor-paginated aggregation of everything the caller can
   * act on: claimable winnings, refundable stakes, in-flight submissions,
   * settled history, and positions that cannot proceed. A failed on-chain read
   * yields `state: "unavailable"`, never an empty result and never a zeroed
   * amount.
   */
  router.get(
    "/me/claim-inbox",
    authMiddleware,
    asyncHandler(async (req, res) => {
      // Ownership comes from the verified session, never from a query
      // parameter. There is deliberately no way to ask for another wallet's
      // inbox.
      const { walletAddress } = req.user ?? {};
      if (!walletAddress) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const parsed = ClaimInboxQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw apiError(400, "INVALID_QUERY", "Invalid limit or cursor");
      }
      const { limit, cursor } = parsed.data;

      const started = Date.now();
      const page = await service.getInbox(walletAddress, limit, cursor ?? null);

      logger.info(
        {
          subsystem: "claim-inbox",
          // Masked, not the raw account: this line is a request-volume
          // counter, and a full wallet id in a log is an identifier that
          // outlives the request. The scan is still correlatable within a
          // single request via the request id.
          walletAddress: maskWalletAddress(walletAddress),
          itemCount: page.items.length,
          actionable: page.summary.actionable,
          unavailable: page.summary.unavailable,
          hasMore: page.hasMore,
          verificationComplete: page.verificationComplete,
          latencyMs: Date.now() - started,
        },
        "Claim inbox served",
      );

      // Wallet-private: the response is scoped to one account, and a shared
      // cache would serve one wallet another's balances.
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Authorization");
      res.json(page);
    }),
  );

  return router;
}
