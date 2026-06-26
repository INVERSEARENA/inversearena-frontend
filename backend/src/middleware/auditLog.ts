import type { Request, Response, NextFunction, RequestHandler } from "express";
import { AuditLogModel } from "../db/models/auditLog.model";
import { logger } from "../utils/logger";

/**
 * Express middleware that automatically writes an audit log entry for every
 * admin route response.  Attach it after authentication so req.adminId is set.
 *
 * The action name is derived from the HTTP method + route path, e.g.:
 *   POST /admin/rounds/resolve  →  "POST /admin/rounds/resolve"
 *
 * Additional context (resourceId, metadata) can be injected by route handlers
 * via res.locals before the response is sent:
 *   res.locals.auditResourceId = req.params.id;
 *   res.locals.auditMetadata   = { dryRun: true };
 */
export function auditLogMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Intercept the response finish event to know the final status
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      // Write the audit log entry asynchronously — do not block the response
      writeAuditLog(req, res, body).catch((err) => {
        // Log but never crash the request due to audit failure
        logger.error({ err, method: req.method, path: req.path }, "Failed to write audit log entry");
      });
      return originalJson(body);
    };

    next();
  };
}

async function writeAuditLog(
  req: Request,
  res: Response,
  _body: unknown
): Promise<void> {
  const adminId = req.adminId;
  if (!adminId) return; // Not an authenticated admin request — skip

  const action = `${req.method} ${req.route?.path ?? req.path}`;
  const resourceId =
    (res.locals.auditResourceId as string | undefined) ??
    req.params.id ??
    undefined;

  const status: "success" | "failed" = res.statusCode < 400 ? "success" : "failed";

  await AuditLogModel.create({
    adminId,
    action,
    resourceType: deriveResourceType(req.path),
    resourceId: resourceId ?? "unknown",
    status,
    metadata: res.locals.auditMetadata as Record<string, unknown> | undefined,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
}

function deriveResourceType(path: string): string {
  // Extract the first meaningful path segment after /admin/
  const segments = path.replace(/^\/admin\//, "").split("/");
  return segments[0] ?? "unknown";
}
