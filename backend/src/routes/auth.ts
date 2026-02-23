import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { AuthController } from "../controllers/auth.controller";
import type { RequestHandler } from "express";

export function createAuthRouter(
  controller: AuthController,
  authMiddleware: RequestHandler
): Router {
  const router = Router();

  // Public endpoints
  router.post("/nonce", asyncHandler(controller.requestNonce));
  router.post("/verify", asyncHandler(controller.verify));
  router.post("/refresh", asyncHandler(controller.refresh));

  // Protected — requires valid JWT
  router.get("/me", authMiddleware, asyncHandler(controller.me));

  return router;
}
