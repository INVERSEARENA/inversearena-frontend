/**
 * Resolves a domain asset code to the authoritative on-chain identity the
 * asset-readiness preflight needs (#1487).
 *
 * Two different notions of "asset" meet in this app:
 *   - the **domain** code the backend speaks (`"XLM" | "USDC" | "EURC"`), used
 *     in arena/pool/payout records; and
 *   - the **on-chain** identity a `changeTrust` is keyed by — the exact
 *     `(code, issuer)` pair for a classic credit asset, or nothing at all for
 *     native XLM.
 *
 * The mapping between them is deployment configuration, not something derivable
 * from the data. A contract id cannot yield an issuer, and there is no safe
 * default issuer, so this module refuses to guess: a code with no configured
 * issuer resolves to {@link StakeAssetResolution} `unconfigured`, and the
 * preflight turns that into a blocking, non-actionable state rather than
 * letting the user sign an ungated business transaction.
 *
 * @module
 */

import { stellarConfig } from "@/lib/stellarConfig";
import type { AssetDescriptor } from "./stellar-asset-reader";

/** Asset codes the backend uses in arena, pool, and payout records. */
export const DOMAIN_ASSET_CODES = ["XLM", "USDC", "EURC"] as const;

export type DomainAssetCode = (typeof DOMAIN_ASSET_CODES)[number];

/** True when `value` is one of the codes the backend emits. */
export function isDomainAssetCode(value: string): value is DomainAssetCode {
  return (DOMAIN_ASSET_CODES as readonly string[]).includes(value);
}

export type StakeAssetResolution =
  | { kind: "resolved"; asset: AssetDescriptor }
  | {
      kind: "unconfigured";
      /** The domain code that could not be resolved, for the error message. */
      code: string;
      /**
       * Which env var would fix it, so a deployment can be corrected without
       * reading the source.
       */
      envVar: string;
    };

const ISSUER_ENV_VAR: Record<Exclude<DomainAssetCode, "XLM">, string> = {
  USDC: "NEXT_PUBLIC_USDC_ISSUER",
  EURC: "NEXT_PUBLIC_EURC_ISSUER",
};

/**
 * Resolve a domain asset code to a preflight-ready descriptor.
 *
 * `issuers` is injected rather than read from `stellarConfig` directly so this
 * stays a pure function — and so the throwing `stellarConfig` proxy (raised
 * only when the module is misconfigured) cannot leak into it.
 */
export function resolveStakeAsset(
  code: string,
  issuers: Readonly<Record<string, string>> = {},
): StakeAssetResolution {
  const normalized = code.trim().toUpperCase();

  if (normalized === "XLM") {
    return { kind: "resolved", asset: { kind: "native", code: "XLM" } };
  }

  if (!isDomainAssetCode(normalized)) {
    return {
      kind: "unconfigured",
      code,
      envVar: `NEXT_PUBLIC_${normalized}_ISSUER`,
    };
  }

  const issuer = issuers[normalized];
  if (typeof issuer !== "string" || issuer.length === 0) {
    return {
      kind: "unconfigured",
      code: normalized,
      envVar: ISSUER_ENV_VAR[normalized as Exclude<DomainAssetCode, "XLM">],
    };
  }

  return {
    kind: "resolved",
    asset: { kind: "credit", code: normalized, issuer },
  };
}

/**
 * {@link resolveStakeAsset} against the live config.
 *
 * Reads `stellarConfig.assetIssuers`, which throws when the module is
 * misconfigured. That is intended: an app with no Stellar configuration at all
 * should not pretend an asset is ready.
 */
export function resolveStakeAssetFromConfig(code: string): StakeAssetResolution {
  return resolveStakeAsset(code, stellarConfig.assetIssuers);
}
