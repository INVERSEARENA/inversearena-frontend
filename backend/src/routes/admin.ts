import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { auditLogMiddleware } from "../middleware/auditLog";
import type { AdminController } from "../controllers/admin.controller";
import type { RoundController } from "../controllers/round.controller";
import type { RequestHandler } from "express";

export function createAdminRouter(
  controller: AdminController,
  roundController: RoundController,
  authMiddleware: RequestHandler
): Router {
  const router = Router();

  // Automatically audit every admin route response
  router.use(auditLogMiddleware());

  // Token request: requires admin auth but no confirmation token
  router.post("/tokens/request", authMiddleware, asyncHandler(controller.requestToken));

  // Destructive operations: require admin auth + confirmation token
  router.post(
    "/transactions/:id/force-resolve",
    authMiddleware,
    asyncHandler(controller.forceResolveTransaction)
  );
  router.post(
    "/transactions/:id/resubmit",
    authMiddleware,
    asyncHandler(controller.resubmitTransaction)
  );
  router.post("/pools/:id/reindex", authMiddleware, asyncHandler(controller.reindexPool));
  router.post("/reconciliation/run", authMiddleware, asyncHandler(controller.runReconciliation));

  // Round management: admin-only
  router.post("/rounds/:id/close", authMiddleware, asyncHandler(roundController.closeRound));
  router.post("/rounds/resolve", authMiddleware, asyncHandler(roundController.resolveRound));

  // Read-only: requires admin auth
  router.get("/audit-logs", authMiddleware, asyncHandler(controller.listAuditLogs));

  return router;
}
