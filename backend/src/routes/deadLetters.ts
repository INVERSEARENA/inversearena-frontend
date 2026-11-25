import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { auditLogMiddleware } from "../middleware/auditLog";
import { apiError } from "../utils/apiError";
import type { DeadLetterService } from "../services/deadLetterService";
import type { AdminService } from "../services/adminService";
import type { RequestHandler } from "express";

const RedriveSchema = z.object({
  token: z.string().min(1),
  feeOverrideBudget: z.number().int().positive().max(10_000_000).optional(),
});

const MarkResolvedSchema = z.object({
  token: z.string().min(1),
  reason: z.string().min(5).max(500),
});

const ListQuerySchema = z.object({
  arenaId: z.string().optional(),
  errorClass: z.string().optional(),
  olderThanDays: z.coerce.number().int().positive().max(365).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

/**
 * Dead-letter operator console routes (#1859).
 *
 * GET  /api/admin/dead-letters          — list dead-lettered jobs with filters
 * GET  /api/admin/dead-letters/:id      — inspect a single dead-letter item
 * POST /api/admin/dead-letters/:id/redrive   — re-drive (requires confirmation token)
 * POST /api/admin/dead-letters/:id/resolve   — mark resolved (requires confirmation token)
 */
export function createDeadLetterRouter(
  deadLetterService: DeadLetterService,
  adminService: AdminService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.use(auditLogMiddleware());

  router.get(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const parsed = ListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw apiError(400, "BAD_REQUEST", parsed.error.errors[0]?.message ?? "Invalid query");
      }
      const result = await deadLetterService.list(parsed.data);
      res.json(result);
    }),
  );

  router.get(
    "/:id",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const item = await deadLetterService.inspect(req.params.id!);
      if (!item) throw apiError(404, "NOT_FOUND", "Dead-letter item not found");
      res.json(item);
    }),
  );

  router.post(
    "/:id/redrive",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const adminId = req.adminId!;
      const id = req.params.id!;

      const parsed = RedriveSchema.safeParse(req.body);
      if (!parsed.success) {
        throw apiError(400, "BAD_REQUEST", "token is required");
      }

      await adminService.verifyAndConsumeToken(parsed.data.token, "redrive_dead_letter", id, adminId);

      const result = await deadLetterService.redrive(id, adminId, parsed.data.feeOverrideBudget);
      res.json(result);
    }),
  );

  router.post(
    "/:id/resolve",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const adminId = req.adminId!;
      const id = req.params.id!;

      const parsed = MarkResolvedSchema.safeParse(req.body);
      if (!parsed.success) {
        throw apiError(400, "BAD_REQUEST", "token and reason are required");
      }

      await adminService.verifyAndConsumeToken(parsed.data.token, "mark_resolved_dead_letter", id, adminId);

      await deadLetterService.markResolved(id, adminId, parsed.data.reason);
      res.status(200).json({ id, status: "resolved" });
    }),
  );

  return router;
}
