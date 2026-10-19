import {
  NonceRequestSchema,
  NonceResponseSchema,
  RefreshSchema,
  STELLAR_WALLET_EXAMPLE,
  TokenPairSchema,
  VerifySchema,
  AuthUserResponseSchema,
  LogoutResponseSchema,
} from "../validation/authSchemas";
import { SignPayoutBodySchema, TransactionIdParamSchema, YieldUpdateSchema } from "../validation/requestValidation";
import { RoundInputSchema } from "../types/round";
import { ClaimInboxPageSchema } from "../types/claimInbox";
import { z } from "./zodOpenApi";

const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  }),
});

export const CreatePayoutBodySchema = z.object({
  payoutId: z.string().openapi({ example: "payout-round-42-winner" }),
  destinationAccount: z.string().openapi({ example: STELLAR_WALLET_EXAMPLE }),
  amount: z.string().openapi({ example: "10.5" }),
  asset: z.enum(["XLM", "USDC"]).openapi({ example: "XLM" }),
  idempotencyKey: z.string().openapi({ example: "idem:payout:round-42:001" }),
});

export const LeaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  cursor: z.string().optional(),
});

export const KeysetPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25).optional(),
  cursor: z.string().max(512).optional(),
});

export const LeaderboardEntrySchema = z.object({
  id: z.string(),
  rank: z.number().int(),
  walletAddress: z.string(),
  survivalStreak: z.number(),
  totalYield: z.number(),
  arenasWon: z.number().int(),
});

export const LeaderboardResponseSchema = z.object({
  players: z.array(LeaderboardEntrySchema),
  nextCursor: z.string().nullable(),
});

export const ArenaStatsSchema = z.object({
  arenaId: z.string().uuid(),
  totalPools: z.number().int(),
  totalStake: z.number(),
  participantCount: z.number().int(),
});

export const ArenaParticipantSchema = z.object({
  walletAddress: z.string(),
  stakeAmount: z.number(),
  joinedAt: z.string().datetime(),
});

export const ArenaParticipantsResponseSchema = z.object({
  items: z.array(ArenaParticipantSchema),
  cursor: z.number().int(),
  hasMore: z.boolean(),
});

export const ArenaYieldPointSchema = z.object({
  round: z.number().int(),
  timestamp: z.string().datetime(),
  rateBps: z.string().nullable(),
  accrued: z.string(),
  cumulative: z.string(),
});

export const ArenaYieldResponseSchema = z.object({
  arenaId: z.string().uuid(),
  asset: z.string(),
  assetDecimals: z.number().int(),
  points: z.array(ArenaYieldPointSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  finished: z.boolean(),
});

export const ArenaYieldQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().optional(),
});

export const ArenaIdParamSchema = z.object({
  id: z.string().uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

export const TransactionRecordSchema = z.object({
  id: z.string(),
  status: z.string(),
  payoutId: z.string().optional(),
  unsignedXdr: z.string().optional(),
  signedXdr: z.string().optional(),
  txHash: z.string().optional(),
});

export {
  NonceRequestSchema,
  NonceResponseSchema,
  VerifySchema,
  RefreshSchema,
  TokenPairSchema,
  AuthUserResponseSchema,
  LogoutResponseSchema,
  SignPayoutBodySchema,
  TransactionIdParamSchema,
  RoundInputSchema,
  ApiErrorSchema,
  YieldUpdateSchema,
  ClaimInboxPageSchema,
};
