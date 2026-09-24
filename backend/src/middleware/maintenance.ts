import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { MaintenanceService } from "../services/maintenanceService";
import { apiError } from "../utils/apiError";
import { logger } from "../utils/logger";
import { maintenanceMutationsBlockedTotal } from "../utils/metrics";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Admin routes stay reachable so an admin can cancel the very window that's
// blocking everyone else; auth routes stay reachable so nobody is locked out
// of their account for the duration; the public status route is exempt too,
// though it would already pass as a GET.
const EXEMPT_PREFIXES = ["/api/admin", "/api/auth", "/api/maintenance"];

function isExempt(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  return EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}

/**
 * Blocks mutating requests while a maintenance window is active; reads
 * always pass through untouched (#1399 acceptance criterion). Ledger-clock
 * failures (RPC outage) fail closed and surface as the same 503 the rest of
 * the app already returns for a Soroban outage — most mutations need live
 * Soroban reads/writes to do anything useful anyway, so this isn't a new
 * failure mode, just a consistent one.
 */
export function maintenanceGuard(service: MaintenanceService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (isExempt(req)) {
      next();
      return;
    }

    try {
      const status = await service.getStatus();
      if (status.active && status.window) {
        maintenanceMutationsBlockedTotal.inc({ method: req.method });
        logger.warn(
          { subsystem: "maintenance", method: req.method, path: req.path, windowId: status.window.id },
          "Mutation blocked by active maintenance window",
        );
        next(
          apiError(
            503,
            "MAINTENANCE_MODE",
            status.window.endLedgerSequence !== null
              ? `Mutating actions are disabled for maintenance until ledger ${status.window.endLedgerSequence}.`
              : "Mutating actions are disabled for maintenance until further notice.",
          ),
        );
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
