/**
 * Arena routes (#1749).
 * Thin route file wiring validation and middleware to ArenaController & ArenaStreamController.
 */

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { cacheMiddleware } from "../middleware/cache";
import { publicCache } from "../middleware/cachePolicy";
import { CacheKeys, cacheTTL } from "../cache/cacheService";
import { prisma } from "../db/prisma";
import { ArenaService } from "../services/arenaService";
import { ArenaQueryService } from "../services/arenaQueryService";
import { ArenaParticipantsService } from "../services/arenaParticipantsService";
import { ArenaStatsService } from "../services/arenaStatsService";
import { ArenaYieldService } from "../services/arenaYieldService";
import { RoundService } from "../services/roundService";
import { ParticipantEligibilityService } from "../services/participantEligibilityService";
import { ActiveStakeLimitsService } from "../services/activeStakeLimitsService";
import { ArenaHealthService } from "../services/arenaHealthService";
import { DisputeEvidenceService } from "../services/disputeEvidenceService";
import { CancellationRecoveryService } from "../services/cancellationRecoveryService";
import { RematchService } from "../services/rematchService";
import { createRateLimitMiddleware, getSyncPlayersRateLimitConfig } from "../middleware/rateLimit";
import { createSseConnectionLimitMiddleware } from "../middleware/sseConnectionLimit";
import { arenaTimeRouter } from "./arenaTime";
import { ArenaController } from "../controllers/arenaController";
import { ArenaStreamController } from "../controllers/arenaStreamController";

const CreateArenaSchema = z.object({
  entryFee: z.number().finite().positive(),
  maxPlayers: z.number().int().min(2),
  joinDeadline: z.string().datetime(),
  stakeToken: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
  txHash: z.string().trim().regex(/^[0-9a-f]{64}$/i, "Invalid transaction hash"),
  rematchOf: z.string().trim().regex(/^C[A-Z2-7]{55}$/, "Invalid rematch source arena id").optional(),
});

const ParticipantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.coerce.number().int().min(0).default(0),
});

const EligibilityPreflightSchema = z.object({
  balance: z.number().positive(),
  balanceAsset: z.enum(["USDC", "XLM", "EURC"]).default("USDC"),
});

const CommitStatusParamsSchema = z.object({
  id: z.string().min(1),
  roundNumber: z.coerce.number().int().min(1),
});

const EvidenceParamsSchema = z.object({
  id: z.string().min(1),
  roundNumber: z.coerce.number().int().min(1),
});

export function createArenasRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const arenaService = new ArenaService(prisma);
  const arenaQueryService = new ArenaQueryService(prisma);
  const arenaParticipantsService = new ArenaParticipantsService(prisma);
  const arenaStatsService = new ArenaStatsService(prisma);
  const arenaYieldService = new ArenaYieldService(prisma);
  const eligibilityService = new ParticipantEligibilityService(prisma);
  const stakeService = new ActiveStakeLimitsService(prisma);
  const arenaHealthService = new ArenaHealthService(prisma);
  const rematchService = new RematchService(prisma);

  let roundService: RoundService | undefined;
  function getRoundService(): RoundService {
    if (!roundService) roundService = new RoundService(prisma);
    return roundService;
  }

  let disputeEvidenceService: DisputeEvidenceService | undefined;
  function getDisputeEvidenceService(): DisputeEvidenceService {
    if (!disputeEvidenceService) {
      disputeEvidenceService = new DisputeEvidenceService(
        prisma,
        getRoundService(),
        new CancellationRecoveryService(prisma),
      );
    }
    return disputeEvidenceService;
  }

  const controller = new ArenaController(
    arenaService,
    arenaQueryService,
    arenaParticipantsService,
    arenaStatsService,
    arenaYieldService,
    getRoundService,
    eligibilityService,
    stakeService,
    arenaHealthService,
    getDisputeEvidenceService,
    rematchService,
  );
  const streamController = new ArenaStreamController(arenaService);
  const sseConnectionLimiter = createSseConnectionLimitMiddleware();
  const syncPlayersRateLimiter = createRateLimitMiddleware(getSyncPlayersRateLimitConfig());

  router.use(arenaTimeRouter);

  router.post("/", authMiddleware, asyncHandler(async (req, res) => {
    CreateArenaSchema.parse(req.body);
    await controller.createArena(req, res);
  }));

  router.get("/", publicCache({ maxAge: 30, staleWhileRevalidate: 120 }), cacheMiddleware((req) => {
    return CacheKeys.arena.list(
      (req.query.filter as string) || "all",
      (req.query.q as string) || "",
      (req.query.limit as string) || "25",
      (req.query.cursor as string) || "0",
    );
  }, cacheTTL.ARENA_LIST ?? 30), asyncHandler((req, res) => controller.listArenas(req, res)));

  router.get("/:id/stats", publicCache({ maxAge: 15, staleWhileRevalidate: 60 }), cacheMiddleware(
    (req) => CacheKeys.arena.stats(req.params.id ?? ""),
    cacheTTL.ARENA_STATS ?? 15,
  ), asyncHandler((req, res) => controller.getArenaStats(req, res)));

  router.get("/:id/rematch-config", authMiddleware, asyncHandler((req, res) => controller.getRematchConfig(req, res)));
  router.get("/:id/yield", publicCache({ maxAge: 60, staleWhileRevalidate: 300 }), cacheMiddleware(
    (req) => CacheKeys.arena.yield(req.params.id ?? ""),
    cacheTTL.ARENA_YIELD ?? 60,
  ), asyncHandler((req, res) => controller.getArenaYield(req, res)));

  router.get("/:id/rounds", authMiddleware, asyncHandler((req, res) => controller.getRounds(req, res)));

  router.get("/:id/participants", asyncHandler(async (req, res) => {
    const { limit, cursor } = ParticipantsQuerySchema.parse(req.query);
    req.query.limit = String(limit);
    req.query.cursor = String(cursor);
    await controller.getParticipants(req, res);
  }));

  router.post("/:id/eligibility-preflight", authMiddleware, asyncHandler(async (req, res) => {
    EligibilityPreflightSchema.parse(req.body);
    await controller.eligibilityPreflight(req, res);
  }));

  router.get("/:id/eligibility-snapshot/:snapshotId", authMiddleware, asyncHandler((req, res) => controller.getEligibilitySnapshot(req, res)));

  router.get("/:id/rounds/:roundNumber/commit-status", authMiddleware, asyncHandler(async (req, res) => {
    CommitStatusParamsSchema.parse(req.params);
    await controller.getCommitStatus(req, res);
  }));

  router.get("/:id/rounds/:roundNumber/evidence", authMiddleware, asyncHandler(async (req, res) => {
    EvidenceParamsSchema.parse(req.params);
    await controller.getEvidence(req, res);
  }));

  router.get("/:id/stream", authMiddleware, sseConnectionLimiter, asyncHandler((req, res) => streamController.handleStream(req, res)));

  router.post("/:id/sync-players", authMiddleware, syncPlayersRateLimiter, asyncHandler((req, res) => controller.syncPlayers(req, res)));

  router.get("/:id/health", cacheMiddleware((req) => CacheKeys.arena.health(req.params.id ?? ""), 10), asyncHandler((req, res) => controller.getArenaHealth(req, res)));

  return router;
}
