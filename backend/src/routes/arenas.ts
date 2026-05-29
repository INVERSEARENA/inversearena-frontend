import { randomUUID } from "crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import { prisma } from "../db/prisma";
import { apiError } from "../utils/apiError";
import { ArenaService } from "../services/arenaService";
import { ArenaStatsService } from "../services/arenaStatsService";

const CreateArenaSchema = z.object({
  entryFee: z.number().finite().positive(),
  maxPlayers: z.number().int().min(2),
  joinDeadline: z.string().datetime(),
  stakeToken: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
});

function writeSseEvent(
  res: { write: (chunk: string) => void },
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createArenasRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const arenaService = new ArenaService(prisma);
  const arenaStatsService = new ArenaStatsService(prisma);

  /**
   * POST /api/arenas
   * Creates an arena record and records the pending factory deployment metadata.
   */
  router.post(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const input = CreateArenaSchema.parse(req.body);
      const createdBy = req.user?.walletAddress;

      if (!createdBy) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const arena = await arenaService.createArena(input, createdBy);
      res.status(201).json({
        arena,
        requestId: randomUUID(),
      });
    }),
  );

  /**
   * GET /api/arenas/:id/stats
   * Returns stats for a specific arena.
   * Cached for 15s — arena state changes with game rounds.
   */
  router.get(
    "/:id/stats",
    cacheMiddleware((req) => cacheKeys.arenaStats(req.params.id!), cacheTTL.ARENA_STATS),
    asyncHandler(async (req, res) => {
      const id = req.params.id!;

      try {
        const stats = await arenaStatsService.getArenaStats(id);
        res.json(stats);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          throw apiError(404, "ARENA_NOT_FOUND", error.message);
        }
        throw error;
      }
    }),
  );

  /**
   * GET /api/arenas/:id/stream
   * Streams arena lifecycle events using Server-Sent Events.
   */
  router.get(
    "/:id/stream",
    asyncHandler(async (req, res) => {
      const id = req.params.id!;
      const heartbeatMs = 15_000;
      const pollMs = 2_500;

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      let active = true;
      let pollTimer: NodeJS.Timeout | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let sequence = 0;
      const seenEliminations = new Set<string>();
      let lastRoundState: string | null = null;
      let lastStatus: string | null = null;
      let lastSurvivorCount: number | null = null;
      let initialSnapshotSent = false;

      const cleanup = (): void => {
        active = false;
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      const sendEvent = (event: string, payload: unknown): void => {
        sequence += 1;
        writeSseEvent(res, event, {
          type: event,
          sequence,
          arenaId: id,
          payload,
          createdAt: new Date().toISOString(),
        });
      };

      heartbeatTimer = setInterval(() => {
        if (!active) return;
        res.write(`: ping ${Date.now()}\n\n`);
      }, heartbeatMs);

      const poll = async (): Promise<void> => {
        if (!active) return;

        try {
          const snapshot = await arenaService.getSnapshot(id);

          if (!initialSnapshotSent) {
            initialSnapshotSent = true;
            lastRoundState = snapshot.lastRoundState;
            lastStatus = snapshot.status;
            lastSurvivorCount = snapshot.survivorCount;
            snapshot.recentEliminations.forEach((entry) => seenEliminations.add(entry.id));
            sendEvent("snapshot", snapshot);
          } else {
            for (const elimination of snapshot.recentEliminations) {
              if (seenEliminations.has(elimination.id)) continue;
              seenEliminations.add(elimination.id);
              sendEvent("player_eliminated", elimination);
            }

            if (snapshot.lastRoundState === "RESOLVED" && lastRoundState !== "RESOLVED") {
              sendEvent("round_resolved", {
                arenaId: snapshot.arenaId,
                roundNumber: snapshot.currentRound,
                playerCount: snapshot.playerCount,
                survivorCount: snapshot.survivorCount,
                status: snapshot.status,
              });
            }

            const isTerminal = snapshot.status === "settled" || snapshot.survivorCount <= 1;
            const wasTerminal =
              lastStatus === "settled" ||
              (lastSurvivorCount !== null && lastSurvivorCount <= 1);
            if (isTerminal && !wasTerminal) {
              sendEvent("game_finished", {
                arenaId: snapshot.arenaId,
                roundNumber: snapshot.currentRound,
                survivorCount: snapshot.survivorCount,
                status: snapshot.status,
              });
            }

            lastRoundState = snapshot.lastRoundState;
            lastStatus = snapshot.status;
            lastSurvivorCount = snapshot.survivorCount;
          }
        } catch (error) {
          if (!active) return;
          sendEvent("error", {
            message: error instanceof Error ? error.message : "Failed to stream arena updates",
          });
        } finally {
          if (active) {
            pollTimer = setTimeout(() => {
              void poll();
            }, pollMs);
          }
        }
      };

      req.on("close", cleanup);
      void poll();
    }),
  );

  return router;
}
