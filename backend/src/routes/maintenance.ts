import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { publicCache } from "../middleware/cachePolicy";
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
    // #1626: public and identical for every caller — a client asks this before
    // any mutation. Edge-cacheable so a scheduled window's broadcast does not
    // stampede the origin; short max-age keeps transitions timely.
    publicCache({ maxAge: 10, staleWhileRevalidate: 60 }),
    asyncHandler(async (_req, res) => {
      const status = await service.getStatus();
      res.json(status);
    }),
  );

  return router;
}
