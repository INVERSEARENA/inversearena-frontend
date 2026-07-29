import { randomUUID } from "crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { cacheKeys, cacheTTL } from "../cache/cacheService";
import { subscribeArena } from "../cache/arenaPoller";
import { prisma } from "../db/prisma";
import type { CreateArenaInput } from "../types/arena";
import { ArenaService } from "../services/arenaService";
import { ArenaStatsService } from "../services/arenaStatsService";
import { RoundRepository } from "../repositories/roundRepository";
import { apiError } from "../utils/apiError";
import type { ArenaParticipant } from "../types/arena";
import { getOnChainPlayers } from "../services/onChainReader";

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
  // Hash of the caller's own `create_pool` invocation on the factory contract.
  // The backend verifies this on-chain and reads the real arena address from
  // it — it never generates a contract address itself.
  txHash: z.string().trim().regex(/^[0-9a-f]{64}$/i, "Invalid transaction hash"),
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

  /**
   * POST /api/arenas
   * Creates an arena record and records the pending factory deployment metadata.
   */
  router.post(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { txHash, ...rest } = CreateArenaSchema.parse(req.body);
      const input = rest as unknown as CreateArenaInput;
      const createdBy = req.user?.walletAddress;

      if (!createdBy) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const arena = await arenaService.confirmArenaDeployment(input, createdBy, txHash);
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
   *
   * Uses a shared poller per arena (see arenaPoller.ts) so that N connected
   * spectators result in only 1 DB query per poll interval, not N.
   */
  router.get(
    "/:id/stream",
    asyncHandler(async (req, res) => {
      const id = req.params.id!;

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const sendEvent = (event: string, payload: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const sendSnapshot = (data: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: snapshot\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const unsubscribe = subscribeArena(
        id,
        { sendEvent, sendSnapshot },
        arenaService,
      );

      req.on("close", unsubscribe);
    }),
  );

  /**
   * POST /api/arenas/:id/sync-players
   * Syncs on-chain player list to the database.
   * Reads the contract's get_players() paginated response and upserts player records.
   */
  router.post(
    "/:id/sync-players",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      if (!id) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena id is required");
      }

      const arena = await prisma.arena.findUnique({ where: { id } });
      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${id} not found`);
      }

      const metadata = (arena.metadata as Record<string, unknown>) ?? {};
      const contractAddress = metadata.contractAddress as string | undefined;

      if (!contractAddress) {
        throw apiError(400, "NO_CONTRACT_ADDRESS", "Arena has no contract address");
      }

      // Fetch on-chain player list
      const onChainPlayers = await getOnChainPlayers(contractAddress);

      // Upsert players: create User records if they don't exist
      let syncedCount = 0;
      for (const walletAddress of onChainPlayers) {
        // Find or create user by wallet address
        await prisma.user.upsert({
          where: { walletAddress },
          update: {},
          create: { walletAddress },
        });
        syncedCount++;
      }

      res.json({
        arenaId: id,
        totalPlayers: onChainPlayers.length,
        syncedPlayers: syncedCount,
        message: `Synced ${syncedCount} players from on-chain`,
      });
    }),
  );

  return router;
}
