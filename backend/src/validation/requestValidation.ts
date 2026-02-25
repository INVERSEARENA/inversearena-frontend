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
