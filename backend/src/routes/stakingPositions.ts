/**
 * Chain-backed staking position routes (#1510).
 *
 * Exposes an authenticated, additive resource describing the caller's staking
 * position as read from the staking contract. Amounts are exact integer minor
 * units serialised as decimal strings; an unreadable chain yields
 * `freshness: "unavailable"` with null amounts rather than a zero balance.
 */

import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { apiError } from "../utils/apiError";
import {
  StakingNotConfiguredError,
  StakingPositionService,
  type StakingPositionServiceDeps,
} from "../services/stakingPositionService";

export function createStakingPositionsRouter(
  authMiddleware: any,
  deps: StakingPositionServiceDeps = {},
): Router {
  const router = Router();
  const service = new StakingPositionService(deps);

  /**
   * GET /api/users/me/staking/positions
   * Returns the authenticated wallet's chain-backed staking position.
   */
  router.get(
    "/me/staking/positions",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const wallet = req.user?.walletAddress;
      if (!wallet) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      try {
        const position = await service.getPosition(wallet);
        res.json({ version: 1, position });
      } catch (error) {
        if (error instanceof StakingNotConfiguredError) {
          throw apiError(503, error.code, error.message);
        }
        throw error;
      }
    }),
  );

  return router;
}
