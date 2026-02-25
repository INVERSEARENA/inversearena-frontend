import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { UsersController } from "../controllers/users.controller";
import type { RequestHandler } from "express";

export function createUsersRouter(
  controller: UsersController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // Protected — requires valid JWT
  router.get("/me", authMiddleware, asyncHandler(controller.me));

  return router;
}
