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
import { ClaimInboxService } from "../services/claimInboxService";
import { createCancellationRefundClaimSource } from "../services/claimInboxSources";
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

  const findRefunds = createCancellationRefundClaimSource(prisma, cancellation);

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
