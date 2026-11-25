import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import type { RequestHandler } from "express";
import { prisma } from "../db/prisma";
import { ReferralService } from "../services/referralService";
import { apiError } from "../utils/apiError";
import { z } from "zod";

const ApplyReferralCodeSchema = z.object({
  code: z.string().trim().min(1),
});

export function createReferralsRouter(
  authMiddleware: RequestHandler
): Router {
  const router = Router();
  const referralService = new ReferralService(prisma);

  /**
   * GET /api/referrals/code
   * Get or create the player's referral code
   */
  router.get(
    "/code",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const code = await referralService.getOrCreateReferralCode(userId);
      res.json({ code });
    })
  );

  /**
   * GET /api/referrals/dashboard
   * Get referral dashboard with stats and referrals list
   */
  router.get(
    "/dashboard",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const dashboard = await referralService.getReferralDashboard(userId);
      res.json(dashboard);
    })
  );

  /**
   * POST /api/referrals/apply
   * Apply a referral code during signup/login
   */
  router.post(
    "/apply",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) throw apiError(401, "UNAUTHORIZED", "Unauthorized");

      const { code } = ApplyReferralCodeSchema.parse(req.body);

      const referrerId = await referralService.attributeSignup(code, userId);
      if (!referrerId) {
        throw apiError(
          400,
          "INVALID_REFERRAL_CODE",
          "Invalid or expired referral code"
        );
      }

      res.json({ success: true, referrerId });
    })
  );

  return router;
}
