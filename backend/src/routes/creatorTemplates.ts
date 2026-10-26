/**
 * backend/src/routes/creatorTemplates.ts
 *
 * Versioned arena configuration templates (#1689).
 *
 * A template is a named, wallet-owned bundle of arena settings. Every route
 * is authenticated and scoped to the owning wallet: a template that belongs
 * to another wallet is reported as not found, so ownership cannot be probed
 * by id.
 *
 * The API is additive — `create_pool` on the factory is unchanged. Applying
 * a template only prefills the creation form; the creator still goes through
 * the transaction preview, the balance check and the trustline check.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/validate";
import { prisma } from "../db/prisma";
import { apiError } from "../utils/apiError";
import { CreatorTemplateService } from "../services/creatorTemplateService";
import {
  TEMPLATE_ROUND_SPEEDS,
  TEMPLATE_SCHEMA_VERSION,
  type ArenaTemplatePayload,
} from "../services/arenaTemplateSchema";
import { env } from "../config/env";

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const NAME = z.string().trim().min(1).max(80);

const PayloadSchema = z.object({
  // Canonical minor-unit amount, never a display string (#1689).
  stakeAmountMinor: z.string().regex(/^\d+$/),
  assetDecimals: z.number().int().min(0).max(9),
  asset: z.string().regex(CONTRACT_ID),
  capacity: z.number().int().min(1).max(10_000),
  roundSpeed: z.enum(TEMPLATE_ROUND_SPEEDS),
  roundDurationSeconds: z.number().int().positive(),
  startDeadlineSeconds: z.number().int().positive().optional(),
  yieldVault: z.string().regex(CONTRACT_ID).optional(),
  oracle: z.string().regex(CONTRACT_ID).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const CreateSchema = z.object({
  name: NAME,
  payload: PayloadSchema,
  schemaVersion: z.number().int().min(0).optional(),
});

const UpdateSchema = z.object({
  name: NAME.optional(),
  payload: PayloadSchema.optional(),
  expectedRevision: z.number().int().positive(),
});

const CloneSchema = z.object({ name: NAME });

const ArchiveSchema = z.object({ archived: z.boolean() });

const ListQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export function createCreatorTemplatesRouter(authMiddleware: RequestHandler): Router {
  const router = Router();
  const service = new CreatorTemplateService(prisma, {
    asset: env.STAKE_TOKEN_CONTRACT_ID ?? undefined,
    vault: env.RWA_VAULT_CONTRACT_ID ?? undefined,
    oracle: env.ORACLE_CONTRACT_ID ?? undefined,
  });

  function idOf(req: { params: Record<string, string | undefined> }): string {
    const id = idOf(req);
    if (!id) {
      throw apiError(400, "TEMPLATE_ID_REQUIRED", "A template id is required");
    }
    return id;
  }

  function ownerOf(req: { user?: { id: string } }): string {
    const owner = req.user?.id;
    if (!owner) {
      throw apiError(401, "UNAUTHORIZED", "Wallet authentication required");
    }
    return owner;
  }

  /**
   * GET /api/creator/templates
   * The templates owned by the authenticated wallet, each with the
   * field-level remediation for whatever is stale in it.
   */
  router.get(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const { includeArchived } = ListQuerySchema.parse(req.query);
      const result = await service.listTemplates(ownerOf(req), { includeArchived });
      res.json(result);
    }),
  );

  /**
   * POST /api/creator/templates
   * Creates a template. The payload is validated against the current
   * protocol bounds, registry lifecycle and deployment capabilities; a
   * payload that does not satisfy them is refused field by field.
   */
  router.post(
    "/",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const body = CreateSchema.parse(req.body);
      const template = await service.createTemplate(ownerOf(req), {
        name: body.name,
        payload: body.payload as unknown as ArenaTemplatePayload,
        schemaVersion: body.schemaVersion,
      });
      res.status(201).json(template);
    }),
  );

  /**
   * GET /api/creator/templates/:id
   */
  router.get(
    "/:id",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const template = await service.getTemplate(ownerOf(req), idOf(req));
      res.json(template);
    }),
  );

  /**
   * PATCH /api/creator/templates/:id
   * Updates a template. `expectedRevision` must match the stored revision:
   * a concurrent edit is refused instead of overwritten.
   */
  router.patch(
    "/:id",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const body = UpdateSchema.parse(req.body);
      const template = await service.updateTemplate(ownerOf(req), idOf(req), {
        name: body.name,
        payload: body.payload as unknown as ArenaTemplatePayload,
        expectedRevision: body.expectedRevision,
      });
      res.json(template);
    }),
  );

  /**
   * POST /api/creator/templates/:id/clone
   */
  router.post(
    "/:id/clone",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const body = CloneSchema.parse(req.body);
      const template = await service.cloneTemplate(ownerOf(req), idOf(req), body.name);
      res.status(201).json(template);
    }),
  );

  /**
   * POST /api/creator/templates/:id/archive
   * Archives or unarchives a template.
   */
  router.post(
    "/:id/archive",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const body = ArchiveSchema.parse(req.body);
      const template = await service.setArchived(ownerOf(req), idOf(req), body.archived);
      res.json(template);
    }),
  );

  /**
   * DELETE /api/creator/templates/:id
   */
  router.delete(
    "/:id",
    authMiddleware,
    asyncHandler(async (req, res) => {
      await service.deleteTemplate(ownerOf(req), idOf(req));
      res.status(204).send();
    }),
  );

  /**
   * POST /api/creator/templates/:id/use
   * Returns the payload to prefill the creation form, revalidated against
   * the current rules, with the field-level remediation for whatever is
   * stale. The payload is a suggestion — the form still validates and the
   * transaction still goes through its preview.
   */
  router.post(
    "/:id/use",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const template = await service.prepareForUse(ownerOf(req), idOf(req));
      res.json(template);
    }),
  );

  return router;
}

/** The schema version this deployment writes (#1689). */
export const CREATOR_TEMPLATE_SCHEMA_VERSION = TEMPLATE_SCHEMA_VERSION;
