export interface AssetMetadata {
  code: string;
  issuer?: string;
  decimals: number;
  displayDecimals: number;
  minimumAmount: number;
  maximumAmount: number;
  symbol: string;
  description?: string;
}

export interface AmountMetadata {
  asset: AssetMetadata;
  displayAmount: string;
  atomicAmount: string;
  usdValue?: number;
}

export const ASSET_DECIMALS: Record<string, number> = {
  USDC: 6,
  XLM: 7,
  EURC: 6,
};

export const ASSET_DISPLAY_DECIMALS: Record<string, number> = {
  USDC: 2,
  XLM: 7,
  EURC: 2,
};

export const ASSET_LIMITS: Record<string, { min: number; max: number }> = {
  USDC: { min: 1, max: 1000000 },
  XLM: { min: 1, max: 10000000 },
  EURC: { min: 1, max: 1000000 },
};

export function getAssetMetadata(code: string, issuer?: string): AssetMetadata {
  const decimals = ASSET_DECIMALS[code] ?? 6;
  const displayDecimals = ASSET_DISPLAY_DECIMALS[code] ?? 2;
  const limits = ASSET_LIMITS[code] ?? { min: 1, max: 1000000 };

  return {
    code,
    issuer,
    decimals,
    displayDecimals,
    minimumAmount: limits.min,
    maximumAmount: limits.max,
    symbol: code,
    description: getAssetDescription(code),
  };
}

function getAssetDescription(code: string): string {
  const descriptions: Record<string, string> = {
    USDC: "USD Coin - Stablecoin backed by USD reserves",
    XLM: "Stellar Lumens - Native asset of the Stellar network",
    EURC: "Euro Coin - EUR-backed stablecoin",
  };
  return descriptions[code] ?? `${code} asset`;
}

export function formatAmount(atomicAmount: string | number, decimals: number, displayDecimals: number): string {
  const numericAmount = typeof atomicAmount === "string" ? BigInt(atomicAmount) : BigInt(atomicAmount);
  const divisor = BigInt(10 ** decimals);
  const wholePart = numericAmount / divisor;
  const fractionalPart = numericAmount % divisor;

  const fractionalStr = fractionalPart
    .toString()
    .padStart(decimals, "0")
    .slice(0, displayDecimals);

  if (displayDecimals === 0) {
    return wholePart.toString();
  }

  return `${wholePart}.${fractionalStr}`;
}

export function parseAmount(displayAmount: string, decimals: number): string {
  const [wholePart, fractionalPart = ""] = displayAmount.split(".");
  const fractionalStr = fractionalPart.padEnd(decimals, "0").slice(0, decimals);
  const atomicAmount = BigInt(wholePart) * BigInt(10 ** decimals) + BigInt(fractionalStr);
  return atomicAmount.toString();
}
