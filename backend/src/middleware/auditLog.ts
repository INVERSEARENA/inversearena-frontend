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
  const action = `${req.method} ${req.route?.path ?? req.path}`;
  const resourceId =
    (res.locals.auditResourceId as string | undefined) ??
    req.params.id ??
    undefined;

  if (!adminId) {
    // Authentication itself failed (bad/missing API key), so req.adminId was
    // never set. Still record the attempt — keyed by IP rather than adminId —
    // so repeated unauthorized hits against destructive admin routes leave a
    // trail instead of vanishing silently.
    if (res.statusCode !== 401) return; // Not an admin-auth failure — skip

    await AuditLogModel.create({
      adminId: `unauthenticated:${req.ip ?? "unknown"}`,
      action,
      resourceType: deriveResourceType(req.path),
      resourceId: resourceId ?? "unknown",
      status: "auth_failed",
      metadata: res.locals.auditMetadata as Record<string, unknown> | undefined,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return;
  }

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
  // Extract the first meaningful path segment, skipping any leading
  // "api"/"admin" mount-prefix segments. req.path is router-relative while
  // handling the request (e.g. "/audit-logs") but reverts to the full
  // mounted path once a request has unwound to the top-level error handler
  // (e.g. "/api/admin/reconciliation/run") — this handles both.
  const segments = path.split("/").filter((s) => s.length > 0 && s !== "api" && s !== "admin");
  return segments[0] ?? "unknown";
}
