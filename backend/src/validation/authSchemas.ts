import { z } from "../openapi/zodOpenApi";

const PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

export const STELLAR_WALLET_EXAMPLE =
  "GCKFBEIYZNPXL3XGD2UAZATF4ZEMCOKINAXKIOX6YRCKRBFA6LVKODML";

export const NonceRequestSchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .regex(PUBLIC_KEY_REGEX, "Invalid Stellar wallet address")
    .openapi({ example: STELLAR_WALLET_EXAMPLE }),
});

export const VerifySchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .regex(PUBLIC_KEY_REGEX, "Invalid Stellar wallet address")
    .openapi({ example: STELLAR_WALLET_EXAMPLE }),
  signature: z
    .string()
    .min(1, "Signature is required")
    .openapi({ example: "base64-ed25519-signature" }),
});

export const RefreshSchema = z.object({
  refreshToken: z
    .string()
    .min(1, "Refresh token is required")
    .openapi({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }),
});

export const NonceResponseSchema = z.object({
  nonce: z.string().openapi({ example: "Sign this message to authenticate: abc123" }),
  expiresAt: z.string().datetime().openapi({ example: "2026-05-31T12:00:00.000Z" }),
});

export const TokenPairSchema = z.object({
  accessToken: z.string().openapi({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }),
  refreshToken: z.string().openapi({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }),
});

export const AuthUserResponseSchema = z.object({
  id: z.string(),
  walletAddress: z.string(),
  displayName: z.string().nullable(),
  joinedAt: z.coerce.date(),
  lastLoginAt: z.coerce.date(),
});

export const LogoutResponseSchema = z.object({
  message: z.string(),
});
