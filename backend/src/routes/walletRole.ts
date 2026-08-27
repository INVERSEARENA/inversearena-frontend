import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { WalletRoleController } from "../controllers/walletRole.controller";

/**
 * Public, read-only "am I an admin" check for a connected wallet address.
 * Unauthenticated on purpose: a wallet must be able to ask this before it
 * has any other credential, and the answer only ever reveals a boolean.
 */
export function createWalletRoleRouter(): Router {
  const router = Router();
  const controller = new WalletRoleController();

  router.get("/wallet-role", asyncHandler(controller.checkRole));

  return router;
}
