/**
 * Domain-asset resolution tests (#1487).
 *
 * The load-bearing property is the refusal: a `changeTrust` is keyed by the
 * exact `(code, issuer)` pair, so a wrong or absent issuer cannot be papered
 * over with a default. `resolveStakeAsset` must therefore resolve XLM and
 * nothing it has not been told about.
 */

import {
  isDomainAssetCode,
  resolveStakeAsset,
  DOMAIN_ASSET_CODES,
} from "@/shared-d/utils/stake-asset";

const ISSUER = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";

describe("resolveStakeAsset", () => {
  it("resolves XLM as native, which never needs a trustline", () => {
    const result = resolveStakeAsset("XLM", { USDC: ISSUER });

    expect(result).toEqual({ kind: "resolved", asset: { kind: "native", code: "XLM" } });
  });

  it("resolves a configured credit asset to an exact (code, issuer) pair", () => {
    const result = resolveStakeAsset("USDC", { USDC: ISSUER });

    expect(result).toEqual({
      kind: "resolved",
      asset: { kind: "credit", code: "USDC", issuer: ISSUER },
    });
  });

  it("is case- and whitespace-insensitive, because arena records are not normalised", () => {
    expect(resolveStakeAsset("  usdc ", { USDC: ISSUER })).toEqual({
      kind: "resolved",
      asset: { kind: "credit", code: "USDC", issuer: ISSUER },
    });
  });

  it("refuses a credit asset with no configured issuer, naming the env var to set", () => {
    const result = resolveStakeAsset("USDC", {});

    expect(result).toEqual({
      kind: "unconfigured",
      code: "USDC",
      envVar: "NEXT_PUBLIC_USDC_ISSUER",
    });
  });

  it("treats an empty issuer string as unconfigured rather than valid", () => {
    expect(resolveStakeAsset("USDC", { USDC: "" })).toMatchObject({
      kind: "unconfigured",
    });
  });

  it("refuses a code outside the known set rather than inventing an issuer", () => {
    const result = resolveStakeAsset("BTC", {});

    expect(result).toEqual({
      kind: "unconfigured",
      code: "BTC",
      envVar: "NEXT_PUBLIC_BTC_ISSUER",
    });
  });

  it("refuses an empty code", () => {
    expect(resolveStakeAsset("", {})).toMatchObject({ kind: "unconfigured", code: "" });
  });
});

describe("isDomainAssetCode", () => {
  it("accepts exactly the codes the backend emits", () => {
    for (const code of DOMAIN_ASSET_CODES) {
      expect(isDomainAssetCode(code)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const code of ["", "xlm", "BTC", "USDC ", "USDCX"]) {
      expect(isDomainAssetCode(code)).toBe(false);
    }
  });
});
