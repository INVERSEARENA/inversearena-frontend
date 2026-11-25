import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { DataExportService } from "../services/dataExportService";
import type { RequestHandler } from "express";
import { apiError } from "../utils/apiError";
import { ErasureRequestModel } from "../db/models/erasureRequest.model";
import { RETENTION_MATRIX } from "../services/dataExportService";
import { z } from "zod";

const ErasureRequestSchema = z.object({
  reason: z.enum(["user_request", "regulatory"]).default("user_request"),
  confirm: z.boolean().refine((v) => v === true, "Confirmation required"),
});

/**
 * Data export and right-to-erasure routes (#1739).
 *
 * GET    /api/users/me/data-export   — export all user-linked data as JSON
 * GET    /api/users/me/retention      — show the retention matrix
 * POST   /api/users/me/erasure        — submit an erasure request
 * GET    /api/users/me/erasure/status — check the status of an erasure request
 *
 * All routes require JWT auth — the user's own data only.
 */
export function createDataExportRouter(
  service: DataExportService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.use(authMiddleware);

  /**
   * Export all user-linked data as a JSON archive.
   * This is the "right to data portability" endpoint.
   */
  router.get(
    "/me/data-export",
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      const walletAddress = req.user?.walletAddress;
      if (!userId || !walletAddress) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const archive = await service.exportUserData(userId, walletAddress);
      res.json(archive);
    }),
  );

  /**
   * Show the retention matrix so the user understands what can and
   * cannot be erased before they submit a request.
   */
  router.get(
    "/me/retention",
    asyncHandler(async (_req, res) => {
      res.json(RETENTION_MATRIX);
    }),
  );

  /**
   * Submit a right-to-erasure request.
   *
   * This creates an ErasureRequest record. The actual erasure is executed
   * immediately if there are no blockers (pending payouts, etc.), or the
   * request is marked "blocked" with a human-readable reason.
   */
  router.post(
    "/me/erasure",
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      const walletAddress = req.user?.walletAddress;
      if (!userId || !walletAddress) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const parsed = ErasureRequestSchema.parse(req.body);

      // Check for existing pending erasure request
      const existing = await ErasureRequestModel.findOne({
        userId,
        status: { $in: ["pending", "in_progress"] },
      });
      if (existing) {
        throw apiError(409, "CONFLICT", "An erasure request is already in progress");
      }

      // Execute erasure immediately (no async job queue for simplicity —
      // the erasure is fast enough to run inline)
      const result = await service.executeErasure(userId, walletAddress);

      let status: "completed" | "blocked";
      let summary: string | null;
      let blockedReason: string | null;

      if (result.blockers.length > 0) {
        status = "blocked";
        blockedReason = result.blockers.join("; ");
        summary = null;
      } else {
        status = "completed";
        blockedReason = null;
        summary = `Deleted: ${result.deleted.join(", ")}. Pseudonymized: ${result.pseudonymized.join(", ")}. Revoked: ${result.revoked.join(", ")}.`;
      }

      const erasureRequest = await ErasureRequestModel.create({
        userId,
        walletAddress,
        status,
        reason: parsed.reason,
        completedAt: status === "completed" ? new Date() : null,
        summary,
        blockedReason,
      });

      if (result.blockers.length > 0) {
        res.status(409).json({
          request: {
            id: String(erasureRequest._id),
            status,
            blockedReason,
            createdAt: erasureRequest.createdAt.toISOString(),
          },
        });
      } else {
        res.status(200).json({
          request: {
            id: String(erasureRequest._id),
            status,
            summary,
            deleted: result.deleted,
            pseudonymized: result.pseudonymized,
            revoked: result.revoked,
            createdAt: erasureRequest.createdAt.toISOString(),
          },
        });
      }
    }),
  );

  /**
   * Check the status of an erasure request.
   */
  router.get(
    "/me/erasure/status",
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const requests = await ErasureRequestModel
        .find({ userId })
        .sort({ requestedAt: -1 })
        .limit(10)
        .lean();

      res.json({
        requests: requests.map((r) => ({
          id: String(r._id),
          status: r.status,
          reason: r.reason,
          requestedAt: r.requestedAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          summary: r.summary,
          blockedReason: r.blockedReason,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    }),
  );

  return router;
}
