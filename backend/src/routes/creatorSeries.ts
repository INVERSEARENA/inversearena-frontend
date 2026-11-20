/**
 * Recurring Arena Series API Routes (#1746).
 *
 * Allows hosts to create and manage scheduled series, pause/resume schedules,
 * skip upcoming instances, and confirm one-click creation signatures.
 */

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { apiError } from "../utils/apiError";
import { ArenaSeriesService } from "../services/arenaSeriesService";

const CreateSeriesSchema = z.object({
  templateId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  cadence: z.string().trim().min(5).max(100),
  timezone: z.string().trim().min(1).max(50).optional().default("UTC"),
  endCondition: z
    .object({
      maxInstances: z.number().int().positive().optional(),
      endDate: z.string().datetime().optional(),
    })
    .optional(),
});

const SignInstanceSchema = z.object({
  txHash: z.string().trim().regex(/^[0-9a-f]{64}$/i, "Invalid transaction hash"),
  arenaId: z.string().optional(),
});

export function createCreatorSeriesRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const service = new ArenaSeriesService(prisma);

  function getWalletAddress(req: any): string {
    const address = req.user?.walletAddress;
    if (!address) {
      throw apiError(401, "UNAUTHORIZED", "Wallet authentication required");
    }
    return address;
  }

  /**
   * POST /api/creator/series
   * Creates a new recurring arena series.
   */
  router.post(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const creatorAddress = getWalletAddress(req);
      const input = CreateSeriesSchema.parse(req.body);
      const series = await service.createSeries(creatorAddress, input);
      res.status(201).json({ series });
    }),
  );

  /**
   * GET /api/creator/series
   * Lists recurring arena series owned by the creator.
   */
  router.get(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const creatorAddress = getWalletAddress(req);
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const items = await service.listSeries(creatorAddress, status);
      res.json({ items });
    }),
  );

  /**
   * GET /api/creator/series/:id
   * Returns a specific series with its upcoming and past instances.
   */
  router.get(
    "/:id",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const creatorAddress = getWalletAddress(req);
      const series = await service.getSeriesById(req.params.id!, creatorAddress);
      res.json({ series });
    }),
  );

  /**
   * POST /api/creator/series/:id/pause
   * Pauses an active series.
   */
  router.post(
    "/:id/pause",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const creatorAddress = getWalletAddress(req);
      const series = await service.pauseSeries(req.params.id!, creatorAddress);
      res.json({ series });
    }),
  );

  /**
   * POST /api/creator/series/:id/resume
   * Resumes a paused series.
   */
  router.post(
    "/:id/resume",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const creatorAddress = getWalletAddress(req);
      const series = await service.resumeSeries(req.params.id!, creatorAddress);
      res.json({ series });
    }),
  );

  /**
   * POST /api/creator/series/:id/skip
   * Skips the next scheduled instance of the series.
   */
  router.post(
    "/:id/skip",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const creatorAddress = getWalletAddress(req);
      const series = await service.skipNextInstance(req.params.id!, creatorAddress);
      res.json({ series });
    }),
  );

  /**
   * POST /api/creator/series/:id/instances/:instanceId/sign
   * Records one-click confirmation / signature of a pending instance creation.
   */
  router.post(
    "/:id/instances/:instanceId/sign",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const creatorAddress = getWalletAddress(req);
      const { txHash, arenaId } = SignInstanceSchema.parse(req.body);
      const instance = await service.signInstance(
        req.params.id!,
        req.params.instanceId!,
        creatorAddress,
        txHash,
        arenaId,
      );
      res.json({ instance });
    }),
  );

  return router;
}
