import {
  AssetCodeSchema,
  HorizonAccountResponseSchema,
  StellarPublicKeySchema,
} from "@/shared-d/utils/security-validation";
import { stellarConfig } from "@/lib/stellarConfig";

const HORIZON_URL = stellarConfig.horizonUrl;

/**
 * Balance information for a currency
 */
export interface Balance {
  xlm: number;
  usdc: number;
}

/**
 * Fetch balance for a specific asset from Horizon
 */
export async function fetchAssetBalance(
  publicKey: string,
  assetCode: "XLM" | "USDC",
): Promise<number> {
  const validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  const validatedAssetCode = AssetCodeSchema.parse(assetCode);

  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${validatedPublicKey}`);
    if (!res.ok) {
      return 0;
    }

    const rawData: unknown = await res.json();
    const data = HorizonAccountResponseSchema.parse(rawData);
    const balances = data.balances || [];

    if (validatedAssetCode === "XLM") {
      const nativeBalance = balances.find((balance) => balance.asset_type === "native");
      return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
    }

    const tokenBalance = balances.find(
      (balance) =>
        balance.asset_code === validatedAssetCode && balance.asset_type !== "native",
    );
    return tokenBalance ? parseFloat(tokenBalance.balance) : 0;
  } catch (err) {
    console.error(`Failed to fetch ${validatedAssetCode} balance:`, err);
    return 0;
  }
}

/**
 * Fetch XLM and USDC balances for a wallet in parallel.
 */
export async function fetchWalletBalance(publicKey: string): Promise<Balance> {
  const [xlm, usdc] = await Promise.all([
    fetchAssetBalance(publicKey, "XLM"),
    fetchAssetBalance(publicKey, "USDC"),
  ]);
  return { xlm, usdc };
}
