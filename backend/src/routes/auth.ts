import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { createRateLimitMiddleware, nonceRateLimitConfig } from "../middleware/rateLimit";
import type { AuthController } from "../controllers/auth.controller";
import type { RequestHandler } from "express";

export function createAuthRouter(
  controller: AuthController,
  authMiddleware: RequestHandler
): Router {
  const router = Router();

  const nonceRateLimiter = createRateLimitMiddleware(nonceRateLimitConfig);

  // Public endpoints
  router.post("/nonce", nonceRateLimiter, asyncHandler(controller.requestNonce));
  router.post("/verify", asyncHandler(controller.verify));
  router.post("/refresh", asyncHandler(controller.refresh));

  // Protected — requires valid JWT
  router.get("/me", authMiddleware, asyncHandler(controller.me));
  router.post("/logout", authMiddleware, asyncHandler(controller.logout));
  // Wallet-owner action: invalidate every active session for the caller's
  // wallet (used after wallet compromise, rotation, or full sign-out).
  router.delete("/sessions", authMiddleware, asyncHandler(controller.revokeAllSessions));

  return router;
}
