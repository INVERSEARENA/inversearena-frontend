import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { AdminController } from "../controllers/admin.controller";
import type { RequestHandler } from "express";

export function createAdminRouter(
  controller: AdminController,
  authMiddleware: RequestHandler
): Router {
  const router = Router();

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

  // Read-only: requires admin auth
  router.get("/audit-logs", authMiddleware, asyncHandler(controller.listAuditLogs));

  return router;
}
