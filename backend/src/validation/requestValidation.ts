import { z } from "zod";

const MONGO_OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;
const LEGACY_TRANSACTION_ID_REGEX = /^tx_\d{10,}_[a-f0-9]{8}$/i;

// Accept currently generated UUIDs, legacy tx IDs, and Mongo ObjectId for compatibility.
export const TransactionIdSchema = z
  .string()
  .trim()
  .min(1, "id is required")
  .max(128, "id is too long")
  .refine(
    (value) =>
      z.string().uuid().safeParse(value).success ||
      MONGO_OBJECT_ID_REGEX.test(value) ||
      LEGACY_TRANSACTION_ID_REGEX.test(value),
    "id must be a UUID, Mongo ObjectId, or legacy tx id"
  );

export const TransactionIdParamSchema = z.object({
  id: TransactionIdSchema,
});

export const SignPayoutBodySchema = z.object({
  signedXdr: z
    .string()
    .trim()
    .min(20, "signedXdr is too short")
    .max(200_000, "signedXdr is too large"),
});

export const YieldUpdateSchema = z.object({
  protocol: z.string().trim().min(1).max(64).optional(),
  currentAPY: z.number().finite().min(0).max(100).optional(),
  baseRate: z.number().finite().min(0).max(100).optional(),
  surgeMultiplier: z.number().finite().min(0).max(10).optional(),
  asset: z.string().trim().min(1).max(16).optional(),
});

// Mongo ObjectId is not accepted here (unlike TransactionIdSchema above) —
// transaction intents are always created with crypto.randomUUID().
export const IntentIdParamSchema = z.object({
  id: z.string().trim().uuid("id must be a UUID"),
});

// Self-reported ownership (#1381 — see docs/TRANSACTION_INTENTS.md §1: this
// backend has no wallet-login/JWT flow wired up anywhere yet). Every
// transaction-intents body schema below includes this field explicitly
// because Zod's default z.object() silently strips unrecognized keys, which
// would otherwise drop ownerWallet before the controller ever reads it.
const ownerWalletField = z
  .string()
  .trim()
  .regex(/^G[A-Z2-7]{55}$/, "ownerWallet must be a valid Stellar account ID");

export const RecordSignatureFailureBodySchema = z.object({
  ownerWallet: ownerWalletField,
  reason: z.enum(["rejected", "expired"]),
});

export const MarkAwaitingSignatureBodySchema = z.object({
  ownerWallet: ownerWalletField,
});

export const AttachSignedXdrBodySchema = z.object({
  ownerWallet: ownerWalletField,
  signedXdr: z
    .string()
    .trim()
    .min(20, "signedXdr is too short")
    .max(200_000, "signedXdr is too large"),
});

export const RecordSubmissionOutcomeBodySchema = z.discriminatedUnion("status", [
  z.object({
    ownerWallet: ownerWalletField,
    status: z.literal("confirmed"),
    txHash: z.string().trim().min(1, "txHash is required").max(128, "txHash is too long"),
  }),
  z.object({
    ownerWallet: ownerWalletField,
    status: z.literal("failed"),
    errorMessage: z.string().trim().min(1, "errorMessage is required").max(2_000, "errorMessage is too long"),
  }),
]);

export const IntentOwnerQuerySchema = z.object({
  ownerWallet: ownerWalletField,
});
