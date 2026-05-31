import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheTTL } from "../cache/cacheService";
import { prisma } from "../db/prisma";
import { createRateLimitMiddleware, getPoolsRateLimitConfig } from "../middleware/rateLimit";
import type { RequestHandler } from "express";
import { apiError } from "../utils/apiError";

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

interface DecodedCursor {
  offset: number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset } as DecodedCursor)).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as DecodedCursor;
    if (typeof payload.offset !== "number" || payload.offset < 0) return 0;
    return payload.offset;
  } catch {
    return 0;
  }
}

function formatEliminationLog(log: {
  id: string;
  userId: string;
  reason: string | null;
  eliminatedAt: Date;
  round: { roundNumber: number };
}) {
  return {
    id: log.id,
    userId: log.userId,
    roundNumber: log.round.roundNumber,
    reason: log.reason,
    eliminatedAt: log.eliminatedAt.toISOString(),
  };
}

export function createPoolsRouter(authMiddleware: RequestHandler): Router {
  const router = Router();

  const poolsRateLimiter = createRateLimitMiddleware(getPoolsRateLimitConfig());

  /**
   * POST /api/pools
   * Rate-limited pool creation endpoint.
   */
  router.post(
    "/",
    authMiddleware,
    poolsRateLimiter,
    asyncHandler(async (req, res) => {
      const PoolCreateSchema = z.object({
        arenaId: z.string().uuid(),
        stakeAmount: z.number().positive(),
      });
      const { arenaId, stakeAmount } = PoolCreateSchema.parse(req.body);

      const pool = await prisma.pool.create({
        data: { arenaId, stakeAmount },
      });

      res.status(201).json(pool);
    }),
  );

  /**
   * GET /api/pools/:id/eliminations
   *
   * Returns paginated elimination history for the arena associated with this pool.
   * The cache key includes pool id, limit, and cursor to avoid cross-page data leakage.
   *
   * Query params:
   *  - limit  (1–100, default 25)
   *  - cursor (opaque base64url string for next page)
   *
   * Response:
   *  {
   *    items: EliminationEntry[],
   *    cursor: string | null,
   *    hasMore: boolean
   *  }
   */
  router.get(
    "/:id/eliminations",
    authMiddleware,
    cacheMiddleware(
      (req) =>
        `pool:eliminations:${req.params.id}:${req.query.limit ?? 25}:${req.query.cursor ?? "0"}`,
      cacheTTL.ARENA_STATS,
    ),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        throw apiError(400, "MISSING_POOL_ID", "Pool ID is required");
      }
      const { limit, cursor } = PaginationSchema.parse(req.query);

      const pool = await prisma.pool.findUnique({
        where: { id },
        select: { arenaId: true },
      });

      if (!pool) {
        throw apiError(404, "POOL_NOT_FOUND", "Pool not found");
      }

      const offset = cursor ? decodeCursor(cursor) : 0;

      const logs = await prisma.eliminationLog.findMany({
        where: { round: { arenaId: pool.arenaId } },
        orderBy: { eliminatedAt: "desc" },
        take: limit + 1,
        skip: offset,
        include: { round: { select: { roundNumber: true } } },
      });

      const hasMore = logs.length > limit;
      const items = logs.slice(0, limit).map(formatEliminationLog);

      res.json({
        items,
        cursor: hasMore ? encodeCursor(offset + limit) : null,
        hasMore,
      });
    }),
  );

  return router;
}
