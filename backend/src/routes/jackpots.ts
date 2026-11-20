import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { jackpotService } from "../services/jackpotService";
import { apiError } from "../utils/apiError";
import { cacheMiddleware } from "../middleware/cache";
import { publicCache } from "../middleware/cachePolicy";

const GetJackpotSchema = z.object({
  stakeToken: z.string().trim().min(1).max(32),
});

const GetHistorySchema = z.object({
  stakeToken: z.string().trim().min(1).max(32),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function createJackpotsRouter(requireAuth: RequestHandler) {
  const router = Router();

  router.get(
    "/:stakeToken",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { stakeToken } = GetJackpotSchema.parse(req.params);
      const jackpot = await jackpotService.getJackpotByToken(stakeToken);

      if (!jackpot) {
        return apiError(res, 404, "Jackpot not found");
      }

      res.json({
        id: jackpot.id,
        stakeToken: jackpot.stakeToken,
        balanceAtomic: jackpot.balanceAtomic.toString(),
        shareBps: jackpot.shareBps,
        awardRule: jackpot.awardRule,
        awardThreshold: jackpot.awardThreshold,
        createdAt: jackpot.createdAt.toISOString(),
      });
    }),
  );

  router.get(
    "/:stakeToken/history",
    cacheMiddleware(publicCache),
    asyncHandler(async (req, res) => {
      const { stakeToken, limit } = GetHistorySchema.parse({
        ...req.params,
        ...req.query,
      });

      const awards = await jackpotService.getJackpotHistory(stakeToken, limit);

      res.json({
        awards: awards.map((award) => ({
          id: award.id,
          arenaId: award.arenaId,
          winnerId: award.winnerId,
          amountAtomic: award.amountAtomic.toString(),
          awardReason: award.awardReason,
          status: award.status,
          createdAt: award.createdAt.toISOString(),
        })),
      });
    }),
  );

  return router;
}
