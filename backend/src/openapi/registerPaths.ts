import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import {
  ApiErrorSchema,
  ArenaIdParamSchema,
  ArenaParticipantsResponseSchema,
  ArenaStatsSchema,
  AuthUserResponseSchema,
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
    summary: "Create a payout transaction",
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
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/payouts/{id}",
    summary: "Get payout transaction by id",
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
    summary: "Queue a signed payout XDR",
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
