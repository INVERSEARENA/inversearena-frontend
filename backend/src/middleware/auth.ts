import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthService } from "../services/authService";

// Augment Express Request so controllers can read adminId / user without casting
declare global {
  namespace Express {
    interface Request {
      adminId?: string;
      user?: { id: string; walletAddress: string };
    }
  }
}

export function requireAuth(authService: AuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const payload = authService.verifyAccessToken(token);
      req.user = { id: payload.sub, walletAddress: payload.wallet };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export interface AdminAuthProvider {
  isAdmin(req: Request): Promise<boolean>;
  getAdminId(req: Request): string;
}

/**
 * API-key-based provider. Checks `Authorization: Bearer <ADMIN_API_KEY>`.
 * Swap this for a JwtAuthProvider without touching any routes.
 */
export class ApiKeyAuthProvider implements AdminAuthProvider {
  private readonly apiKey: string;

  constructor() {
    const key = process.env.ADMIN_API_KEY;
    if (!key) throw new Error("ADMIN_API_KEY environment variable is required");
    this.apiKey = key;
  }

  async isAdmin(req: Request): Promise<boolean> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return token === this.apiKey;
  }

  getAdminId(req: Request): string {
    // With API key auth the admin identity is the key prefix (first 8 chars, masked)
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return `apikey:${token.slice(0, 8)}`;
  }
}

export function requireAdmin(provider: AdminAuthProvider): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ok = await provider.isAdmin(req);
      if (!ok) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.adminId = provider.getAdminId(req);
      next();
    } catch (err) {
      next(err);
    }
  };
}
