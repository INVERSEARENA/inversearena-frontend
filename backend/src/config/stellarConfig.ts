import { z } from "zod";

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

const StellarEnvSchema = z.object({
  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(3),
  // On-chain transaction confirmation polling for resolveRound (#1193)
  ROUND_CONFIRM_POLL_MS: z
    .string()
    .optional()
    .transform((v) => Number(v ?? "2500"))
    .pipe(z.number().int().positive()),
  ROUND_CONFIRM_MAX_POLLS: z
    .string()
    .optional()
    .transform((v) => Number(v ?? "20"))
    .pipe(z.number().int().positive()),
});

/** Outbound RPC allowlist + response cap (#1447). Empty allowlist = allow all. */
export const RPC_MAX_RESPONSE_BYTES = Number(process.env.RPC_MAX_RESPONSE_BYTES ?? 1_048_576);
export function assertAllowedRpcUrl(url: string): boolean {
  const hosts = (process.env.RPC_URL_ALLOWLIST ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hosts.length === 0 || hosts.includes(new URL(url).hostname);
}

/**
 * Classic credit-asset issuers, keyed by asset code.
 *
 * Explicit per asset, never inferred. A credit asset is identified by the pair
 * `(code, issuer)`, so a code with no configured issuer cannot be described
 * honestly and must not be given a plausible-looking one. These are the
 * backend counterparts of the frontend's `NEXT_PUBLIC_*_ISSUER` variables and
 * must name the same issuers.
 *
 * A malformed value is a configuration error and throws at boot rather than
 * being dropped, because a silently missing issuer is indistinguishable from
 * a wallet that holds nothing.
 */
const AssetIssuerSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,4}$/, "Asset codes are 1-5 characters and may not start with a digit"),
  issuer: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, "Issuer must be a Stellar account id (G...55 base32 chars)"),
});

const AssetIssuersSchema = z.array(AssetIssuerSchema);

/** Native XLM carries no issuer; every other code needs one. */
export const NATIVE_ASSET_CODE = "XLM";

/**
 * @param spec Comma-separated `CODE:ISSUER` pairs, e.g.
 *   `USDC:GABC...,EURC:GDEF...`. A trailing `CODE:` with an empty issuer is
 *   rejected rather than read as "no issuer configured".
 */
export function parseAssetIssuers(spec: string | undefined): Record<string, string> {
  const trimmed = (spec ?? "").trim();
  if (trimmed === "") return {};
  const pairs = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  const parsed = AssetIssuersSchema.parse(
    pairs.map((pair) => {
      const separator = pair.indexOf(":");
      if (separator < 0) {
        throw new Error(`Malformed ASSET_ISSUERS entry "${pair}": expected CODE:ISSUER`);
      }
      return { code: pair.slice(0, separator).trim(), issuer: pair.slice(separator + 1).trim() };
    }),
  );
  for (const entry of parsed) {
    if (entry.code === NATIVE_ASSET_CODE) {
      throw new Error(`${NATIVE_ASSET_CODE} is native and must not be given an issuer`);
    }
  }
  return Object.fromEntries(parsed.map((entry) => [entry.code, entry.issuer]));
}

export type StellarConfig = {
  sorobanRpcUrl: string;
  networkPassphrase: string;
  roundConfirmPollMs: number;
  roundConfirmMaxPolls: number;
  assetIssuers: Record<string, string>;
};

export function getStellarConfig(
  env: NodeJS.ProcessEnv = process.env,
): StellarConfig {
  const allowTestDefaults = env.NODE_ENV === "test";
  const parsed = StellarEnvSchema.parse({
    SOROBAN_RPC_URL:
      env.SOROBAN_RPC_URL ?? (allowTestDefaults ? TESTNET_RPC_URL : undefined),
    STELLAR_NETWORK_PASSPHRASE:
      env.STELLAR_NETWORK_PASSPHRASE ??
      (allowTestDefaults ? TESTNET_PASSPHRASE : undefined),
    ROUND_CONFIRM_POLL_MS: env.ROUND_CONFIRM_POLL_MS,
    ROUND_CONFIRM_MAX_POLLS: env.ROUND_CONFIRM_MAX_POLLS,
  });

  return {
    sorobanRpcUrl: parsed.SOROBAN_RPC_URL,
    networkPassphrase: parsed.STELLAR_NETWORK_PASSPHRASE,
    roundConfirmPollMs: parsed.ROUND_CONFIRM_POLL_MS,
    roundConfirmMaxPolls: parsed.ROUND_CONFIRM_MAX_POLLS,
    assetIssuers: parseAssetIssuers(env.ASSET_ISSUERS),
  };
}
