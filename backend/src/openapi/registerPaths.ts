import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import {
  ApiErrorSchema,
  ArenaIdParamSchema,
  ArenaParticipantsResponseSchema,
  ArenaStatsSchema,
  ArenaYieldQuerySchema,
  ArenaYieldResponseSchema,
  AuthUserResponseSchema,
  ClaimInboxPageSchema,
  CreatePayoutBodySchema,
  LeaderboardQuerySchema,
  LeaderboardResponseSchema,
  LogoutResponseSchema,
  NonceRequestSchema,
  NonceResponseSchema,
  RefreshSchema,
  RoundInputSchema,
  SignPayoutBodySchema,
  TokenPairSchema,
  TransactionIdParamSchema,
  TransactionRecordSchema,
  VerifySchema,
  YieldUpdateSchema,
} from "./schemas";
import { z } from "./zodOpenApi";

const bearerAuth = {
  type: "http" as const,
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Wallet JWT access token from POST /api/auth/verify",
};

const adminApiKey = {
  type: "apiKey" as const,
  in: "header" as const,
  name: "X-Admin-Api-Key",
  description: "Admin API key for privileged routes",
};

function registerAuthPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "post",
    path: "/api/auth/nonce",
    summary: "Request a sign-in nonce",
    request: {
      body: {
        content: { "application/json": { schema: NonceRequestSchema } },
      },
    },
    responses: {
      201: {
        description: "Nonce issued",
        content: { "application/json": { schema: NonceResponseSchema } },
      },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/auth/verify",
    summary: "Verify wallet signature and issue tokens",
    request: {
      body: {
        content: { "application/json": { schema: VerifySchema } },
      },
    },
    responses: {
      200: {
        description: "Authenticated",
        content: { "application/json": { schema: TokenPairSchema } },
      },
      401: {
        description: "Invalid signature or expired nonce",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/auth/refresh",
    summary: "Refresh access token",
    request: {
      body: {
        content: { "application/json": { schema: RefreshSchema } },
      },
    },
    responses: {
      200: {
        description: "New token pair",
        content: { "application/json": { schema: TokenPairSchema } },
      },
      401: {
        description: "Invalid or revoked refresh token",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/auth/me",
    summary: "Current authenticated user",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "User profile",
        content: { "application/json": { schema: AuthUserResponseSchema } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });
}

function registerArenaPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/api/arenas/{id}/stats",
    summary: "Arena aggregate stats",
    security: [{ bearerAuth: [] }],
    request: { params: ArenaIdParamSchema },
    responses: {
      200: {
        description: "Arena stats",
        content: { "application/json": { schema: ArenaStatsSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/arenas/{id}/participants",
    summary: "Paginated arena participants",
    security: [{ bearerAuth: [] }],
    request: {
      params: ArenaIdParamSchema,
      query: z.object({
        limit: z.coerce.number().int().optional(),
        cursor: z.coerce.number().int().optional(),
      }),
    },
    responses: {
      200: {
        description: "Participant page",
        content: {
          "application/json": { schema: ArenaParticipantsResponseSchema },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/arenas/{id}/yield",
    summary: "Per-round yield time-series for an arena",
    request: {
      params: ArenaIdParamSchema,
      query: ArenaYieldQuerySchema,
    },
    responses: {
      200: {
        description:
          "Ordered yield snapshots (round, timestamp, rate, accrued, cumulative); amounts are decimal strings in the arena stake asset",
        content: {
          "application/json": { schema: ArenaYieldResponseSchema },
        },
      },
      404: {
        description: "Arena not found",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });
}

function registerPublicApiPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/api/leaderboard",
    summary: "Global leaderboard",
    security: [{ bearerAuth: [] }],
    request: { query: LeaderboardQuerySchema },
    responses: {
      200: {
        description: "Leaderboard page",
        content: { "application/json": { schema: LeaderboardResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/payouts",
    summary: "Create a payout transaction (admin)",
    security: [{ adminApiKey: [] }],
    request: {
      body: {
        content: { "application/json": { schema: CreatePayoutBodySchema } },
      },
    },
    responses: {
      201: {
        description: "Payout created or queued",
        content: { "application/json": { schema: TransactionRecordSchema } },
      },
      401: {
        description: "Unauthorized — admin API key required",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/payouts/{id}",
    summary: "Get payout transaction by id",
    security: [{ bearerAuth: [] }],
    request: { params: TransactionIdParamSchema },
    responses: {
      200: {
        description: "Transaction record",
        content: { "application/json": { schema: TransactionRecordSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/transactions/{id}",
    summary: "Get transaction by id",
    security: [{ bearerAuth: [] }],
    request: { params: TransactionIdParamSchema },
    responses: {
      200: {
        description: "Transaction record",
        content: { "application/json": { schema: TransactionRecordSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });
}

function registerAdminPaths(registry: OpenAPIRegistry): void {
  const RoundResolutionSchema = z.object({
    roundId: z.string().uuid(),
    state: z.string(),
    resolution: z.record(z.unknown()).optional(),
  });

  registry.registerPath({
    method: "post",
    path: "/api/admin/rounds/resolve",
    summary: "Resolve a round (admin)",
    security: [{ adminApiKey: [] }],
    request: {
      body: {
        content: { "application/json": { schema: RoundInputSchema } },
      },
    },
    responses: {
      200: {
        description: "Round resolved",
        content: { "application/json": { schema: RoundResolutionSchema } },
      },
      400: {
        description: "Validation error",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/payouts/{id}/sign",
    summary: "Queue a signed payout XDR (admin)",
    security: [{ adminApiKey: [] }],
    request: {
      params: TransactionIdParamSchema,
      body: {
        content: { "application/json": { schema: SignPayoutBodySchema } },
      },
    },
    responses: {
      200: {
        description: "Signed transaction queued",
        content: { "application/json": { schema: TransactionRecordSchema } },
      },
      401: {
        description: "Unauthorized — admin API key required",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      404: {
        description: "Transaction not found or not owned by requester",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });
}

function registerOraclePaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "post",
    path: "/api/oracle/yield",
    summary: "Update current yield data (webhook)",
    request: {
      body: {
        content: { "application/json": { schema: YieldUpdateSchema } },
      },
    },
    responses: {
      200: { description: "Yield data updated" },
      400: {
        description: "Validation error",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });
}

/**
 * Wallet-scoped claim and refund inbox (#1489).
 *
 * Registered in its own function because the response is the one place the
 * service's full state machine is published: clients branch on `state` and
 * `reason` rather than inferring them, and a `unavailable` item must be
 * rendered as an explicit unknown rather than an absence.
 */
function registerClaimInboxPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/api/users/me/claim-inbox",
    summary: "Wallet-scoped claim and refund inbox",
    description:
      "One item per arena, aggregating payout records, cancellation recovery and " +
      "on-chain arena state. Ownership comes from the bearer token; there is no " +
      "wallet parameter. A failed on-chain read yields state `unavailable`, never " +
      "an empty result and never a zeroed amount.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
        cursor: z.string().min(1).max(512).optional(),
      }),
    },
    responses: {
      200: {
        description: "Inbox page",
        content: { "application/json": { schema: ClaimInboxPageSchema } },
      },
      400: {
        description: "Invalid limit or cursor",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      401: {
        description: "Missing or invalid session",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
    },
  });
}

function registerCreatorTemplatePaths(registry: OpenAPIRegistry): void {
  const TemplateRemediationSchema = z.object({
    field: z.string(),
    code: z.string(),
    message: z.string(),
  });

  const TemplatePayloadSchema = z.object({
    stakeAmountMinor: z.string(),
    assetDecimals: z.number().int(),
    asset: z.string(),
    capacity: z.number().int(),
    roundSpeed: z.string(),
    roundDurationSeconds: z.number().int(),
    startDeadlineSeconds: z.number().int().optional(),
    yieldVault: z.string().optional(),
    oracle: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  });

  const TemplateSchema = z.object({
    id: z.string(),
    name: z.string(),
    schemaVersion: z.number().int(),
    status: z.enum(["active", "archived"]),
    payload: TemplatePayloadSchema,
    revision: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    remediation: z.array(TemplateRemediationSchema),
    incompatible: z.boolean(),
  });

  const TemplateListSchema = z.object({
    items: z.array(TemplateSchema),
    totalCount: z.number().int(),
  });

  const commonResponses = {
    401: {
      description: "Missing or invalid session",
      content: { "application/json": { schema: ApiErrorSchema } },
    },
    404: {
      description: "Template not found (also returned for another wallet's template)",
      content: { "application/json": { schema: ApiErrorSchema } },
    },
  };

  registry.registerPath({
    method: "get",
    path: "/api/creator/templates",
    summary: "List the authenticated creator's arena configuration templates",
    description:
      "Every template carries its field-level remediation: what is stale against the " +
      "current protocol bounds, registry lifecycle and deployment capabilities.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({ includeArchived: z.enum(["true", "false"]).optional() }),
    },
    responses: {
      200: {
        description: "The creator's templates",
        content: { "application/json": { schema: TemplateListSchema } },
      },
      ...commonResponses,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/creator/templates",
    summary: "Save an arena configuration template",
    description:
      "The payload is canonical: the stake amount is in the asset's minor units and the " +
      "asset and integrations are contract ids. It is validated against the current " +
      "protocol rules before it is stored; a payload that does not satisfy them is " +
      "refused with field-level remediation.",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(80),
              payload: TemplatePayloadSchema,
              schemaVersion: z.number().int().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The saved template",
        content: { "application/json": { schema: TemplateSchema } },
      },
      409: {
        description: "A template with this name already exists",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      422: {
        description: "The template does not satisfy the current protocol rules",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      ...commonResponses,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/creator/templates/{id}",
    summary: "Read one of the creator's templates",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "The template",
        content: { "application/json": { schema: TemplateSchema } },
      },
      ...commonResponses,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/creator/templates/{id}",
    summary: "Update one of the creator's templates",
    description:
      "`expectedRevision` must match the stored revision, so a concurrent edit is " +
      "refused instead of overwritten.",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(80).optional(),
              payload: TemplatePayloadSchema.optional(),
              expectedRevision: z.number().int().positive(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The updated template",
        content: { "application/json": { schema: TemplateSchema } },
      },
      409: {
        description: "Revision conflict, or the name is taken",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      ...commonResponses,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/creator/templates/{id}/clone",
    summary: "Clone one of the creator's templates",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ name: z.string().min(1).max(80) }) } } },
    },
    responses: {
      201: {
        description: "The clone",
        content: { "application/json": { schema: TemplateSchema } },
      },
      409: {
        description: "A template with this name already exists",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      ...commonResponses,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/creator/templates/{id}/archive",
    summary: "Archive or restore one of the creator's templates",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ archived: z.boolean() }) } } },
    },
    responses: {
      200: {
        description: "The template",
        content: { "application/json": { schema: TemplateSchema } },
      },
      ...commonResponses,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/creator/templates/{id}",
    summary: "Delete one of the creator's templates",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: "Deleted" },
      ...commonResponses,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/creator/templates/{id}/use",
    summary: "Prepare a template for the creation form",
    description:
      "Returns the payload to prefill the creation form, revalidated against the " +
      "current rules. Applying it never bypasses the transaction preview or the " +
      "balance and trustline checks.",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "The template and its remediation",
        content: { "application/json": { schema: TemplateSchema } },
      },
      422: {
        description: "The template's schema version is not supported",
        content: { "application/json": { schema: ApiErrorSchema } },
      },
      ...commonResponses,
    },
  });
}

export function generateOpenApiDocument() {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", "bearerAuth", bearerAuth);
  registry.registerComponent("securitySchemes", "adminApiKey", adminApiKey);

  registerAuthPaths(registry);
  registerArenaPaths(registry);
  registerPublicApiPaths(registry);
  registerAdminPaths(registry);
  registerOraclePaths(registry);
  registerClaimInboxPaths(registry);
  registerCreatorTemplatePaths(registry);

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "InverseArena API",
      version: "0.1.0",
      description:
        "REST API for wallet auth, arenas, pools, leaderboard, payouts, and admin round resolution.",
    },
    servers: [{ url: "/" }],
  });
}
