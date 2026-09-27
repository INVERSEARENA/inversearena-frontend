import { z } from "zod";
import {
  parseStellarAccountId,
  parseSorobanContractId,
  parseStellarTransactionHash,
  parseNetworkPassphrase,
  IdentityValidationError,
} from "@/shared-d/utils/identity-value-objects";

const STELLAR_BASE32 = "[A-Z2-7]";

export const StellarPublicKeySchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      return parseStellarAccountId(v);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof IdentityValidationError ? e.reason : "Invalid Stellar public key",
      });
      return z.NEVER;
    }
  });

export const StellarContractIdSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      return parseSorobanContractId(v, { allowPlaceholder: true });
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof IdentityValidationError ? e.reason : "Invalid Soroban contract id",
      });
      return z.NEVER;
    }
  });

export const PoolCurrencySchema = z.enum(["USDC", "XLM"]);
export const RoundSpeedSchema = z.enum(["30S", "1M", "5M"]);
export const RoundChoiceSchema = z.enum(["Heads", "Tails"]);

export const PositiveAmountSchema = z
  .number()
  .finite()
  .positive("Amount must be greater than zero")
  .max(1_000_000_000, "Amount exceeds maximum allowed value");

export const ArenaCapacitySchema = z
  .number()
  .int()
  .min(2, "Arena capacity is too small")
  .max(10_000, "Arena capacity is too large");

export const RoundNumberSchema = z
  .number()
  .int()
  .min(1, "Round number must be >= 1")
  .max(10_000, "Round number is too large");

export const SignedXdrSchema = z
  .string()
  .trim()
  .min(20, "Signed XDR is too short")
  .max(200_000, "Signed XDR is too large");

export const NetworkPassphraseSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      return parseNetworkPassphrase(v);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof IdentityValidationError ? e.reason : "Invalid network passphrase format",
      });
      return z.NEVER;
    }
  });

export const AssetCodeSchema = z.enum(["XLM", "USDC"]);

export const HorizonAccountResponseSchema = z.object({
  sequence: z.union([z.string(), z.number()]).transform((value) => String(value)),
  balances: z
    .array(
      z.object({
        asset_type: z.string(),
        asset_code: z.string().optional(),
        balance: z.string(),
      })
    )
    .default([]),
});

export const CoinGeckoSimplePriceSchema = z.object({
  cardano: z.object({
    usd: z.number().finite(),
  }),
});

export const AllowedOriginSchema = z
  .string()
  .trim()
  .url("Invalid origin in ALLOWED_ORIGINS")
  .max(2048);

export const AllowedOriginsListSchema = z.array(AllowedOriginSchema).default([]);

export function parseAllowedOrigins(rawOrigins: string | undefined): string[] {
  if (!rawOrigins) return [];
  const parsed = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return AllowedOriginsListSchema.parse(parsed);
}

