import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { apiError } from "../utils/apiError";
import { getUserProfileSummary, ProfileNotFoundError } from "../services/userProfileService";

export class UsersController {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * GET /api/users/me
   *
   * Returns the authenticated user's identity (from MongoDB) plus
   * aggregated game stats (from PostgreSQL via Prisma).
   *
   * Stats returned:
   *  - gamesPlayed  — distinct arenas the user participated in
   *  - gamesWon     — arenas where the user was never eliminated
   *  - totalYieldEarned — sum of payouts from resolved rounds (USDC string)
   *  - currentRank  — 1-based position on the all-time yield leaderboard (null if unranked)
   *
   * The read itself lives in `userProfileService.getUserProfileSummary` so
   * the dashboard bootstrap composer (#1501) returns byte-identical profile
   * data without duplicating the query.
   */
  me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.user!;

    try {
      res.json(await getUserProfileSummary(this.prisma, id));
    } catch (error) {
      if (error instanceof ProfileNotFoundError) {
        next(apiError(404, "USER_NOT_FOUND", "User not found"));
        return;
      }
      next(error);
    }
  };
}
