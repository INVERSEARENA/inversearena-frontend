import { randomUUID } from "crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import { prisma } from "../db/prisma";
import type { CreateArenaInput } from "../types/arena";
import { ArenaService } from "../services/arenaService";
import { ArenaStatsService } from "../services/arenaStatsService";
import { ArenaController } from "../controllers/arena.controller";
import { RoundRepository } from "../repositories/roundRepository";
import { apiError } from "../utils/apiError";
import type { ArenaParticipant } from "../types/arena";

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

const CreateArenaSchema = z.object({
  entryFee: z.number().finite().positive(),
  maxPlayers: z.number().int().min(2),
  joinDeadline: z.string().datetime(),
  stakeToken: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
});

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

const ParticipantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  cursor: z.coerce.number().int().min(0).default(0),
});

function writeSseEvent(
  res: { write: (chunk: string) => void },
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeRoundMetadata(metadata: unknown): {
  playerChoices?: Array<{ userId: string; choice: "heads" | "tails"; stake: number }>;
} {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const value = metadata as Record<string, unknown>;
  const choices = Array.isArray(value.playerChoices) ? value.playerChoices : [];

  return {
    playerChoices: choices
      .map((choice) => {
        if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
          return null;
        }

        const item = choice as Record<string, unknown>;
        const userId = typeof item.userId === "string" ? item.userId : null;
        const roundChoice =
          item.choice === "heads" || item.choice === "tails"
            ? item.choice
            : null;
        const stake = typeof item.stake === "number" ? item.stake : null;

        if (!userId || !roundChoice || stake === null) {
          return null;
        }

        return {
          userId,
          choice: roundChoice,
          stake,
        };
      })
      .filter((choice): choice is { userId: string; choice: "heads" | "tails"; stake: number } => choice !== null),
  };
}

export function createArenasRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const arenaService = new ArenaService(prisma);
  const arenaStatsService = new ArenaStatsService(prisma);
  const roundRepository = new RoundRepository(prisma);
  const arenaController = new ArenaController(prisma);

  /**
   * POST /api/arenas
   * Creates an arena record and records the pending factory deployment metadata.
   */
  router.post(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const input = CreateArenaSchema.parse(req.body) as unknown as CreateArenaInput;
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
    cacheMiddleware((req) => cacheKeys.arenaStats(req.params.id ?? ""), cacheTTL.ARENA_STATS),
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      if (!id) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena id is required");
      }

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

  router.get(
    "/:id/rounds",
    authMiddleware,
    cacheMiddleware(
      (req) => `arena:rounds:${req.params.id}:${req.query.limit ?? 25}:${req.query.cursor ?? "0"}`,
      cacheTTL.ARENA_ROUNDS,
    ),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena id is required");
      }
      const { limit, cursor } = PaginationSchema.parse(req.query);

      const arena = await prisma.arena.findUnique({ where: { id } });
      if (!arena) {
        res.status(404).json({ error: { code: "ARENA_NOT_FOUND" } });
        return;
      }

      const result = await roundRepository.listByArenaId(id, limit, cursor);
      const items = result.items.map((round) =>
        formatRound({
          id: round.id,
          roundNumber: round.roundNumber,
          state: round.state,
          eliminationCount: round.metadata?.resolution?.eliminatedPlayers?.length ?? 0,
          metadata: round.metadata,
          createdAt: round.createdAt,
          updatedAt: round.updatedAt,
        }),
      );

      res.json({
        items,
        cursor: result.cursor,
        hasMore: result.hasMore,
      });
    }),
  );

  /**
   * GET /api/arenas/:id/participants
   * Returns the current round participant manifest with pagination.
   */
  router.get(
    "/:id/participants",
    asyncHandler(async (req, res) => {
      const id = req.params.id!;
      const { limit, cursor } = ParticipantsQuerySchema.parse(req.query);

      const arena = await prisma.arena.findUnique({
        where: { id },
        include: {
          rounds: {
            orderBy: { roundNumber: "desc" },
            take: 1,
            include: {
              eliminationLogs: {
                orderBy: { eliminatedAt: "asc" },
              },
            },
          },
        },
      });

      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${id} not found`);
      }

      const latestRound = arena.rounds[0] ?? null;
      const metadata = normalizeRoundMetadata(latestRound?.metadata);
      const choices = metadata.playerChoices ?? [];
      const userIds = choices.map((choice) => choice.userId);
      const users =
        userIds.length > 0
          ? await prisma.user.findMany({
              where: { id: { in: userIds } },
            })
          : [];

      const userById = new Map(users.map((user) => [user.id, user]));
      const eliminatedUsers = new Set(
        latestRound?.eliminationLogs.map((entry) => entry.userId) ?? [],
      );

      const participants: ArenaParticipant[] = choices.map((choice, index) => {
        const user = userById.get(choice.userId);
        const status: ArenaParticipant["status"] = eliminatedUsers.has(choice.userId)
          ? "ELIMINATED"
          : latestRound?.state === "OPEN"
            ? "READY"
            : "ACTIVE";

        return {
          id: `${latestRound?.id ?? id}:${choice.userId}:${index}`,
          walletAddress: user?.walletAddress ?? choice.userId,
          choice: choice.choice,
          stake: choice.stake,
          status,
          roundNumber: latestRound?.roundNumber ?? 0,
          joinedAt: (latestRound?.createdAt ?? arena.createdAt).toISOString(),
        };
      });

      const total = participants.length;
      const items = participants.slice(cursor, cursor + limit);

      res.json({
        arenaId: id,
        total,
        nextCursor: cursor + limit < total ? cursor + limit : null,
        hasMore: cursor + limit < total,
        items,
      });
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

  /**
   * GET /api/arenas/:id/participants
   * Returns paginated list of participants in a specific arena.
   * Cached for 5s — participant status changes with round eliminations.
   */
  router.get(
    "/:id/participants",
    cacheMiddleware(
      (req) => `arena:participants:${req.params.id}:${req.query.limit || 25}:${req.query.cursor || ""}`,
      5
    ),
    asyncHandler(arenaController.getParticipants)
  );

  return router;
}
