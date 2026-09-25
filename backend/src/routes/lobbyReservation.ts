/**
 * Lobby capacity reservation routes (#1406).
 *
 * Backend-authoritative reservation of a lobby slot ahead of a player
 * actually signing their stake transaction, so two players racing for an
 * arena's last slot cannot both proceed to sign only to have one fail
 * on-chain after paying a network fee. See lobbyReservationStore for the
 * atomicity/expiry guarantees.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { apiError } from "../utils/apiError";
import { prisma } from "../db/prisma";
import { ArenaStatsService } from "../services/arenaStatsService";
import { lobbyReservationStore } from "../cache/lobbyReservationStore";
import {
  createRateLimitMiddleware,
  getLobbyReservationRateLimitConfig,
} from "../middleware/rateLimit";

const RESERVATION_TTL_SECONDS = Math.max(
  1,
  Number(process.env.LOBBY_RESERVATION_TTL_SECONDS) || 120,
);

const ArenaIdParamsSchema = z.object({
  id: z.string().min(1),
});

export function createLobbyReservationRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const statsService = new ArenaStatsService(prisma);
  const reservationLimiter = createRateLimitMiddleware(getLobbyReservationRateLimitConfig());

  /**
   * POST /api/arenas/:id/reservation
   *
   * Reserves one lobby slot for the authenticated user, or refreshes their
   * existing reservation's TTL if they already hold one. Fails with 409 when
   * confirmed players + active reservations already fill the arena's
   * maxPlayers — the caller should not proceed to build/sign a stake
   * transaction in that case.
   */
  router.post(
    "/:id/reservation",
    authMiddleware,
    reservationLimiter,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const { id: arenaId } = ArenaIdParamsSchema.parse(req.params);

      const arena = await prisma.arena.findUnique({
        where: { id: arenaId },
        select: { id: true },
      });
      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${arenaId} not found`);
      }

      const stats = await statsService.getArenaStats(arenaId);
      if (stats.maxPlayers <= 0) {
        throw apiError(
          409,
          "ARENA_CAPACITY_UNKNOWN",
          "Arena has no configured capacity to reserve against",
        );
      }

      // Confirmed players already consume capacity outright; reservations
      // arbitrate what's left of it among players who are still mid-join.
      const remainingCapacity = stats.maxPlayers - stats.playerCount;

      const result = await lobbyReservationStore.reserveSlot(
        arenaId,
        userId,
        remainingCapacity,
        RESERVATION_TTL_SECONDS,
      );

      if (!result.reserved) {
        throw apiError(409, "ARENA_FULL", "This arena has no open slots right now");
      }

      res.status(201).json({
        arenaId,
        expiresAt: result.expiresAt,
        ttlSeconds: RESERVATION_TTL_SECONDS,
      });
    }),
  );

  /**
   * DELETE /api/arenas/:id/reservation
   *
   * Releases the authenticated user's reservation early (e.g. they closed
   * the join modal without signing). Idempotent: releasing a reservation
   * that doesn't exist (already expired, or never held) is not an error.
   */
  router.delete(
    "/:id/reservation",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const { id: arenaId } = ArenaIdParamsSchema.parse(req.params);
      await lobbyReservationStore.releaseSlot(arenaId, userId);

      res.status(204).send();
    }),
  );

  return router;
}
