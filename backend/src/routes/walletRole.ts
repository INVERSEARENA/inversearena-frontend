import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { WalletRoleController } from "../controllers/walletRole.controller";
import {
  createRateLimitMiddleware,
  getWalletRoleRateLimitConfig,
} from "../middleware/rateLimit";

/**
 * Public, read-only "am I an admin" check for a connected wallet address.
 * Intentionally unauthenticated — a wallet must be able to ask this before
 * it has any credential. Rate-limited to prevent address enumeration.
 */
export function createWalletRoleRouter(): Router {
  const router = Router();
  const controller = new WalletRoleController();
  const rateLimiter = createRateLimitMiddleware(getWalletRoleRateLimitConfig());

  router.get("/wallet-role", rateLimiter, asyncHandler(controller.checkRole));

  return router;
}
