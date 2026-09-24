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
import { RoundService } from "../services/roundService";
import { RoundRepository } from "../repositories/roundRepository";
import { ParticipantEligibilityService } from "../services/participantEligibilityService";
import { apiError } from "../utils/apiError";
import type { ArenaParticipant } from "../types/arena";
import { getOnChainPlayers } from "../services/onChainReader";
import { isAuthorizedAdminWallet } from "../services/walletRoleService";
import { createRateLimitMiddleware, getSyncPlayersRateLimitConfig } from "../middleware/rateLimit";
import { createSseConnectionLimitMiddleware } from "../middleware/sseConnectionLimit";
// Issue #1411 — Responsible active stake limits
import { ActiveStakeLimitsService, ActiveStakeLimitError } from "../services/activeStakeLimitsService";
// Issue #1412 — Arena health summary
import { ArenaHealthService } from "../services/arenaHealthService";
// Issue #1401 — Signed server-time synchronization
import { arenaTimeRouter } from "./arenaTime";

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

const CommitStatusParamsSchema = z.object({
  id: z.string().trim().min(1).max(200),
  roundNumber: z.coerce.number().int().min(1).max(1_000_000),
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
  const eligibilityService = new ParticipantEligibilityService(prisma);
  const sseConnectionLimiter = createSseConnectionLimitMiddleware();
  // Issue #1411
  const stakeService = new ActiveStakeLimitsService(prisma);
  // Issue #1412
  const healthService = new ArenaHealthService(prisma);

  // GET /api/arenas/time (#1401) — mounted from its own module
  // (arenaTime.ts) rather than defined inline here, so it can be
  // unit-tested without constructing arenaService/onChainReader's
  // dependency graph, which has a pre-existing broken cross-boundary
  // import (see the comment in services/serverTimeService.ts) that fails
  // both `tsc --noEmit` and ts-jest module loading whenever anything in
  // this router file is imported.
  router.use(arenaTimeRouter);

  // Constructed lazily (on first use) rather than eagerly here: RoundService's
  // constructor resolves getStellarConfig() immediately, which throws outside
  // NODE_ENV=test when SOROBAN_RPC_URL/STELLAR_NETWORK_PASSPHRASE aren't set.
  // Building this router is a pure, side-effect-free operation that many
  // lightweight route tests rely on (they mount just this router without a
  // full server.ts boot / dotenv load), so router construction must not
  // require Stellar config to be present.
  let roundService: RoundService | undefined;
  function getRoundService(): RoundService {
    if (!roundService) {
      roundService = new RoundService(prisma);
    }
    return roundService;
  }

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
      const userId = req.user?.id;

      if (!createdBy || !userId) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      // Issue #1411 — block if the creator would exceed their active stake cap.
      // entryFee is the incoming stake amount for this arena join.
      try {
        await stakeService.assertBelowActiveStakeLimit(userId, input.entryFee ?? 0);
      } catch (err) {
        if (err instanceof ActiveStakeLimitError) {
          throw apiError(409, err.code, err.message);
        }
        throw err;
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
          // Hide the pick while the round is still open — otherwise any
          // caller could see how others voted and choose accordingly,
          // breaking the minority-wins fairness guarantee (#1212).
          choice: latestRound?.state === "OPEN" ? null : choice.choice,
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
   * POST /api/arenas/:id/eligibility-preflight
   * Verify participant eligibility before join transaction construction.
   * Reports capacity, phase, balance, token, and duplicate-membership failures.
   */
  router.post(
    "/:id/eligibility-preflight",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const { balance, balanceAsset } = z
        .object({
          balance: z.number().positive(),
          balanceAsset: z.enum(["USDC", "XLM", "EURC"]).default("USDC"),
        })
        .parse(req.body);

      if (!id) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena ID is required");
      }

      const playerWallet = req.user?.walletAddress;
      if (!playerWallet) {
        throw apiError(401, "UNAUTHORIZED", "Wallet address required");
      }

      const eligibility = await eligibilityService.checkEligibility(id, playerWallet, balance, balanceAsset);

      res.status(eligibility.isEligible ? 200 : 403).json({
        isEligible: eligibility.isEligible,
        errors: eligibility.errors,
        warnings: eligibility.warnings,
        metadata: eligibility.metadata,
        requestId: randomUUID(),
      });
    }),
  );

  /**
   * GET /api/arenas/:id/rounds/:roundNumber/commit-status
   *
   * Round-scoped commit receipt (#1383): lets the authenticated caller check
   * their own submit_commitment status for a specific round — one of
   * accepted / pending / expired / missing. See
   * backend/docs/COMMIT_RECEIPT_DESIGN.md for the full state machine.
   *
   * Scoped to the caller's own wallet (from the auth token) rather than an
   * arbitrary wallet in the query string — this is a per-player status
   * check, not a public participant listing, and requiring auth avoids
   * letting any caller probe an arbitrary wallet's status for a round that
   * hasn't resolved yet.
   *
   * Not cached: this is a per-player, low-latency indexed lookup, and a
   * shared cache would risk serving one player's status to another.
   */
  router.get(
    "/:id/rounds/:roundNumber/commit-status",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { id: arenaId, roundNumber } = CommitStatusParamsSchema.parse(req.params);
      const callerWallet = req.user?.walletAddress;

      if (!callerWallet) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const arena = await prisma.arena.findUnique({ where: { id: arenaId } });
      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${arenaId} not found`);
      }

      const receipt = await getRoundService().getCommitStatus(arenaId, roundNumber, callerWallet);
      res.json(receipt);
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
    authMiddleware,
    sseConnectionLimiter,
    asyncHandler(async (req, res) => {
      const id = req.params.id!;

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const sendEvent = (event: string, payload: unknown, sequence?: number): void => {
        if (res.writableEnded) return;
        if (sequence !== undefined) res.write(`id: ${sequence}\n`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const sendSnapshot = (data: unknown, sequence?: number): void => {
        if (res.writableEnded) return;
        if (sequence !== undefined) res.write(`id: ${sequence}\n`);
        res.write(`event: snapshot\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const unsubscribe = subscribeArena(
        id,
        { sendEvent, sendSnapshot },
        arenaService,
        (() => {
          const raw = req.get("Last-Event-ID") ?? (typeof req.query.cursor === "string" ? req.query.cursor : undefined);
          if (raw === undefined) return undefined;
          const cursor = Number(raw);
          return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
        })(),
      );

      req.on("close", unsubscribe);
    }),
  );

  /**
   * POST /api/arenas/:id/sync-players
   * Syncs on-chain player list to the database.
   * Reads the contract's get_players() paginated response and upserts player records.
   */
  // Same protection as pools/wallet-role: this route reaches Soroban RPC on
  // every call, so it needs a budget rather than none at all (#1351).
  const syncPlayersRateLimiter = createRateLimitMiddleware(getSyncPlayersRateLimitConfig());

  router.post(
    "/:id/sync-players",
    authMiddleware,
    syncPlayersRateLimiter,
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

      // Authorisation (#1351): a valid JWT alone used to be enough, so any
      // logged-in wallet could drive a live simulateTransaction plus DB writes
      // for every arena id in the system — an authenticated amplification
      // vector against the Soroban RPC with no relationship to the arena.
      // Syncing is now limited to the arena's creator and admin wallets.
      const caller = req.user?.walletAddress;
      if (!caller) {
        throw apiError(401, "UNAUTHORIZED", "Unauthorized");
      }

      const createdBy = metadata.createdBy as string | undefined;
      const isOwner = createdBy !== undefined && createdBy === caller;

      if (!isOwner && !isAuthorizedAdminWallet(caller)) {
        throw apiError(
          403,
          "FORBIDDEN",
          "Only the arena creator or an admin may sync players for this arena",
        );
      }

      const contractAddress = metadata.contractAddress as string | undefined;

      if (!contractAddress) {
        throw apiError(400, "NO_CONTRACT_ADDRESS", "Arena has no contract address");
      }

      // Fetch on-chain player list
      const onChainPlayers = await getOnChainPlayers(contractAddress);

      // Batch-create User records for any wallet addresses that don't exist
      // yet. `skipDuplicates` makes this a single round trip instead of one
      // upsert per player (existing users are left untouched, matching the
      // no-op `update: {}` the previous per-player upsert used).
      await prisma.user.createMany({
        data: onChainPlayers.map((walletAddress) => ({ walletAddress })),
        skipDuplicates: true,
      });

      // `syncedPlayers` mirrors `totalPlayers`, matching the previous
      // per-player upsert loop, which always processed every on-chain
      // player regardless of whether the User record was newly created.
      const syncedCount = onChainPlayers.length;

      res.json({
        arenaId: id,
        totalPlayers: onChainPlayers.length,
        syncedPlayers: syncedCount,
        message: `Synced ${syncedCount} players from on-chain`,
      });
    }),
  );

  /**
   * GET /api/arenas/:id/health
   * Returns a composite health summary for the arena combining chain lag,
   * queue lag, and round state drift. (#1412)
   *
   * Response shape: ArenaHealthSummary
   * Cache TTL: 10s (health is a near-real-time diagnostic signal)
   */
  router.get(
    "/:id/health",
    cacheMiddleware(
      (req) => `arena:health:${req.params.id}`,
      10, // 10 second TTL
    ),
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      if (!id) {
        throw apiError(400, "INVALID_ARENA_ID", "Arena id is required");
      }

      const arena = await prisma.arena.findUnique({ where: { id } });
      if (!arena) {
        throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${id} not found`);
      }

      const health = await healthService.getArenaHealth(id);
      res.json(health);
    }),
  );

  return router;
}
