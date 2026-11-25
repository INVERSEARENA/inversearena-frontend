/**
 * Portfolio Exposure Routes (#1397)
 *
 * Provides portfolio-level exposure summary across active arenas.
 */

import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { PortfolioExposureService } from "../services/portfolioExposureService";
import { apiError } from "../utils/apiError";

export function createPortfolioExposureRouter(authMiddleware: any): Router {
  const router = Router();
  const exposureService = new PortfolioExposureService(prisma);

  /**
   * GET /api/users/me/portfolio
   * Returns portfolio-level exposure summary for the authenticated user.
   */
  router.get(
    "/me/portfolio",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const exposure = await exposureService.getPortfolioExposure(userId);
      res.json(exposure);
    }),
  );

  /**
   * GET /api/users/me/activity/export
   * Returns verifiable personal activity export with ledger references (#1515).
   * Includes arena participation, eliminations, payouts, and deposits with timestamps.
   */
  router.get(
    "/me/activity/export",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const format = req.query.format?.toString() || "json";
      if (!["json", "csv"].includes(format)) {
        throw apiError(400, "INVALID_FORMAT", "Format must be 'json' or 'csv'");
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          eliminationLogs: {
            include: {
              round: {
                include: {
                  arena: true,
                },
              },
            },
            orderBy: { eliminatedAt: "desc" },
          },
          transactions: {
            orderBy: { createdAt: "desc" },
          },
        },
      });

      if (!user) {
        throw apiError(404, "USER_NOT_FOUND", "User not found");
      }

      const activityData = {
        exportedAt: new Date().toISOString(),
        userId: user.id,
        walletAddress: user.walletAddress,
        accountCreatedAt: user.createdAt.toISOString(),
        eliminationHistory: user.eliminationLogs.map((log) => ({
          id: log.id,
          arenaId: log.round.arenaId,
          roundNumber: log.round.roundNumber,
          eliminatedAt: log.eliminatedAt.toISOString(),
          reason: log.reason,
          ledgerSequence: log.round.metadata?.ledgerSequence,
        })),
        transactionHistory: user.transactions.map((tx) => ({
          id: tx.id,
          type: tx.type,
          amount: tx.amount,
          status: tx.status,
          txHash: tx.txHash,
          createdAt: tx.createdAt.toISOString(),
        })),
        summary: {
          totalEliminationsFromArenas: user.eliminationLogs.length,
          totalTransactions: user.transactions.length,
          accountAge: Math.floor(
            (new Date().getTime() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24)
          ),
        },
      };

      if (format === "csv") {
        const csvHeader =
          "Type,Details,Amount,Status,Timestamp,TxHash\n";
        const csvRows = [
          ...user.eliminationLogs.map(
            (log) =>
              `Elimination,Arena ${log.round.arenaId} Round ${log.round.roundNumber},,${log.reason || "N/A"},${log.eliminatedAt.toISOString()},${log.round.metadata?.txHash || ""}`
          ),
          ...user.transactions.map(
            (tx) =>
              `${tx.type},${tx.type},,${tx.status},${tx.createdAt.toISOString()},${tx.txHash}`
          ),
        ];
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="activity-export.csv"');
        res.send(csvHeader + csvRows.join("\n"));
      } else {
        res.json(activityData);
      }
    }),
  );

  return router;
}
