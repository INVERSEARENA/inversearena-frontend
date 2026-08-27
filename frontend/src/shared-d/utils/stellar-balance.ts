import {
  AssetCodeSchema,
  HorizonAccountResponseSchema,
  StellarPublicKeySchema,
} from "@/shared-d/utils/security-validation";
import { stellarConfig } from "@/lib/stellarConfig";

/**
 * Balance information for a currency
 */
export interface Balance {
  xlm: number;
  usdc: number;
}

/**
 * Raised when a balance lookup could not be completed (network failure,
 * Horizon 5xx / rate-limit, malformed response). Distinct from a wallet
 * genuinely holding zero of an asset — callers must not treat this as a
 * zero balance. See #1295.
 */
export class StellarBalanceError extends Error {
  readonly assetCode: "XLM" | "USDC";

  constructor(assetCode: "XLM" | "USDC", message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "StellarBalanceError";
    this.assetCode = assetCode;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Fetch balance for a specific asset from Horizon.
 *
 * Returns a number only when the balance is genuinely known:
 *  - the account exists and holds the asset → that amount
 *  - the account exists but does not hold the asset → 0
 *  - Horizon returns 404 (account not funded yet) → 0
 *
 * Throws {@link StellarBalanceError} for every "couldn't find out" case
 * (network error, 429/5xx, malformed body) so callers can show a retry
 * state instead of silently reporting 0.
 */
export async function fetchAssetBalance(
  publicKey: string,
  assetCode: "XLM" | "USDC",
): Promise<number> {
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  const validatedAssetCode = AssetCodeSchema.parse(assetCode);

  let res: Response;
  try {
    res = await fetch(`${stellarConfig.horizonUrl}/accounts/${validatedPublicKey}`);
  } catch (err) {
    throw new StellarBalanceError(
      validatedAssetCode,
      `Network error while fetching ${validatedAssetCode} balance from Horizon`,
      { cause: err },
    );
  }

  if (!res.ok) {
    // 404 = the account has never been funded on-chain, which is a real,
    // confirmed zero balance rather than a lookup failure.
    if (res.status === 404) {
      return 0;
    }
    throw new StellarBalanceError(
      validatedAssetCode,
      `Horizon returned HTTP ${res.status} while fetching ${validatedAssetCode} balance`,
    );
  }

  let rawData: unknown;
  try {
    rawData = await res.json();
  } catch (err) {
    throw new StellarBalanceError(
      validatedAssetCode,
      `Malformed JSON in Horizon response for ${validatedAssetCode} balance`,
      { cause: err },
    );
  }

  const parsed = HorizonAccountResponseSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new StellarBalanceError(
      validatedAssetCode,
      `Unexpected Horizon response shape for ${validatedAssetCode} balance`,
      { cause: parsed.error },
    );
  }

  const balances = parsed.data.balances || [];

  if (validatedAssetCode === "XLM") {
    const nativeBalance = balances.find((balance) => balance.asset_type === "native");
    return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
  }

  const tokenBalance = balances.find(
    (balance) =>
      balance.asset_code === validatedAssetCode && balance.asset_type !== "native",
  );
  return tokenBalance ? parseFloat(tokenBalance.balance) : 0;
}

/**
 * Fetch XLM and USDC balances for a wallet in parallel.
 *
 * Rejects with {@link StellarBalanceError} if either lookup fails — the
 * caller is expected to surface a retry state rather than defaulting the
 * whole wallet to zero.
 */
export async function fetchWalletBalance(publicKey: string): Promise<Balance> {
  const [xlm, usdc] = await Promise.all([
    fetchAssetBalance(publicKey, "XLM"),
    fetchAssetBalance(publicKey, "USDC"),
  ]);
  return { xlm, usdc };
}
