import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { MaintenanceService } from "../services/maintenanceService";

/**
 * Public, unauthenticated maintenance status — a client must be able to ask
 * "is maintenance active" before deciding whether to even attempt a mutation,
 * and this is itself a read, so it stays available during the window it
 * describes (#1399).
 */
export function createMaintenanceStatusRouter(service: MaintenanceService): Router {
  const router = Router();

  router.get(
    "/maintenance/status",
    asyncHandler(async (_req, res) => {
      const status = await service.getStatus();
      res.json(status);
    }),
  );

  return router;
}
