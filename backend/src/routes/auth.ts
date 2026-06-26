import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import {
  createRateLimitMiddleware,
  getNonceRateLimitConfig,
  getRefreshRateLimitConfig,
  getVerifyRateLimitConfig,
} from "../middleware/rateLimit";
import type { AuthController } from "../controllers/auth.controller";
import type { RequestHandler } from "express";

export function createAuthRouter(
  controller: AuthController,
  authMiddleware: RequestHandler
): Router {
  const router = Router();

  const nonceRateLimiter = createRateLimitMiddleware(getNonceRateLimitConfig());
  const verifyRateLimiter = createRateLimitMiddleware(getVerifyRateLimitConfig());
  const refreshRateLimiter = createRateLimitMiddleware(getRefreshRateLimitConfig());

  // Public endpoints
  router.post("/nonce", nonceRateLimiter, asyncHandler(controller.requestNonce));
  router.post("/verify", verifyRateLimiter, asyncHandler(controller.verify));
  router.post("/refresh", refreshRateLimiter, asyncHandler(controller.refresh));

  // Protected — requires valid JWT
  router.get("/me", authMiddleware, asyncHandler(controller.me));
  router.post("/logout", authMiddleware, asyncHandler(controller.logout));
  // Wallet-owner action: invalidate every active session for the caller's
  // wallet (used after wallet compromise, rotation, or full sign-out).
  router.delete("/sessions", authMiddleware, asyncHandler(controller.revokeAllSessions));

  return router;
}
