import { Router, RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import { ArenaStatsService } from "../services/arenaStatsService";
import { prisma } from "../db/prisma";
import { RoundRepository } from "../repositories/roundRepository";

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
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as DecodedCursor;
    if (typeof payload.offset !== "number" || payload.offset < 0) return 0;
    return payload.offset;
  } catch {
    return 0;
  }
}

function formatRound(round: {
  id: string;
  roundNumber: number;
  state: string;
  createdAt: Date;
  updatedAt: Date;
  eliminationCount: number;
  metadata: unknown;
}) {
  return {
    id: round.id,
    roundNumber: round.roundNumber,
    state: round.state,
    eliminationCount: round.eliminationCount,
    metadata: round.metadata,
    createdAt: round.createdAt.toISOString(),
    updatedAt: round.updatedAt.toISOString(),
  };
}

export function createArenasRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const statsService = new ArenaStatsService(prisma);
  const roundRepository = new RoundRepository(prisma);

  /**
   * GET /api/arenas/:id/stats
   * Returns stats for a specific arena.
   * Cached for 15s — arena state changes with game rounds.
   */
  router.get(
    "/:id/stats",
    cacheMiddleware((req) => cacheKeys.arenaStats(req.params.id), cacheTTL.ARENA_STATS),
    asyncHandler(async (req, res) => {
      const { id } = req.params;

      try {
        const stats = await statsService.getArenaStats(id);
        res.json(stats);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          res.status(404).json({ error: error.message });
        } else {
          throw error;
        }
      }
    }),
  );

  router.get(
    "/:id/rounds",
    authMiddleware,
    cacheMiddleware(
      (req) => `arena:rounds:${req.params.id}:${req.query.limit ?? 25}:${req.query.cursor ?? "0"}`,
      cacheTTL.ARENA_ROUNDS,
    ),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const { limit, cursor } = PaginationSchema.parse(req.query);

      const arena = await prisma.arena.findUnique({ where: { id } });
      if (!arena) {
        res.status(404).json({ error: { code: "ARENA_NOT_FOUND" } });
        return;
      }

      const result = await roundRepository.listByArenaId(id, limit, cursor);
      const items = result.items.map((round) => ({
        id: round.id,
        roundNumber: round.roundNumber,
        state: round.state,
        eliminationCount: round.metadata?.resolution?.eliminatedPlayers?.length ?? 0,
        metadata: round.metadata,
        createdAt: round.createdAt.toISOString(),
        updatedAt: round.updatedAt.toISOString(),
      }));

      res.json({
        items,
        cursor: result.cursor,
        hasMore: result.hasMore,
      });
    }),
  );

  return router;
}
