/**
 * Unit coverage for the canonical asset descriptor and exact amount codec
 * (#1521). Pure module — runs without the Mongo/Redis harness.
 */
import {
  AmbiguousLegacyAssetError,
  AmountOverflowError,
  ASSET_DESCRIPTOR_SCHEMA_VERSION,
  adaptLegacyAsset,
  assetIdentityKey,
  assetsEqual,
  fromMinorUnits,
  makeDescriptor,
  RoundingRequiredError,
  toMinorUnits,
  validateAssetDescriptor,
} from "../src/types/assetDescriptor";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const ISSUER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ISSUER_B = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function issued(overrides: Record<string, unknown> = {}) {
  return makeDescriptor({
    kind: "issued",
    code: "USDC",
    issuer: ISSUER,
    contractId: SAC,
    decimals: 6,
    network: TESTNET,
    ...overrides,
  });
}

describe("asset descriptor (#1521)", () => {
  it("stamps the current schema version", () => {
    expect(issued().schemaVersion).toBe(ASSET_DESCRIPTOR_SCHEMA_VERSION);
  });

  it("distinguishes native and issued assets", () => {
    const native = makeDescriptor({
      kind: "native",
      code: "XLM",
      issuer: null,
      contractId: null,
      decimals: 7,
      network: MAINNET,
    });
    expect(native.kind).toBe("native");
    expect(native.issuer).toBeNull();
    expect(issued().kind).toBe("issued");
  });

  it("rejects a native asset carrying an issuer", () => {
    expect(() =>
      makeDescriptor({
        kind: "native",
        code: "XLM",
        issuer: ISSUER,
        contractId: null,
        decimals: 7,
        network: MAINNET,
      }),
    ).toThrow(/native asset must not carry an issuer/);
  });

  it("rejects an issued asset with neither issuer nor contract id", () => {
    expect(() => issued({ issuer: null, contractId: null })).toThrow(
      /requires an issuer or a contract id/,
    );
  });

  it("rejects out-of-range decimals", () => {
    expect(() => issued({ decimals: 19 })).toThrow(/decimals/);
    expect(() => issued({ decimals: -1 })).toThrow(/decimals/);
    expect(() => issued({ decimals: 6.5 })).toThrow(/decimals/);
  });

  it("rejects a malformed contract id and issuer", () => {
    expect(() => issued({ contractId: "NOTACONTRACT" })).toThrow(/contractId/);
    expect(() => issued({ issuer: "not-an-account" })).toThrow(/issuer/);
  });

  it("treats different issuers of the same code as different assets", () => {
    expect(assetsEqual(issued(), issued({ issuer: ISSUER_B }))).toBe(false);
  });

  it("treats different contract ids as different assets", () => {
    const other = "CA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    expect(assetsEqual(issued(), issued({ contractId: other }))).toBe(false);
  });

  it("treats the same asset on different networks as different assets", () => {
    expect(assetsEqual(issued(), issued({ network: MAINNET }))).toBe(false);
  });

  it("compares equal assets as equal regardless of field order", () => {
    expect(assetsEqual(issued(), issued())).toBe(true);
    expect(assetIdentityKey(issued())).toBe(assetIdentityKey(issued()));
  });

  it("validateAssetDescriptor normalises a valid descriptor", () => {
    const d = validateAssetDescriptor(issued());
    expect(d.schemaVersion).toBe(ASSET_DESCRIPTOR_SCHEMA_VERSION);
  });
});

describe("exact amount codec (#1521)", () => {
  it("scales 0-decimal assets exactly", () => {
    expect(toMinorUnits("42", 0, "reject")).toBe(42n);
    expect(fromMinorUnits(42n, 0)).toBe("42");
  });

  it("scales 7-decimal XLM exactly", () => {
    expect(toMinorUnits("1.0000000", 7, "reject")).toBe(10_000_000n);
    expect(toMinorUnits("0.0000001", 7, "reject")).toBe(1n);
    expect(fromMinorUnits(10_000_000n, 7)).toBe("1.0000000");
  });

  it("scales 18-decimal assets exactly", () => {
    expect(toMinorUnits("1.000000000000000001", 18, "reject")).toBe(1_000_000_000_000_000_001n);
    expect(fromMinorUnits(1_000_000_000_000_000_001n, 18)).toBe("1.000000000000000001");
  });

  it("scales a bigint whole amount exactly", () => {
    expect(toMinorUnits(3n, 6, "reject")).toBe(3_000_000n);
  });

  it("rejects floating-point number input", () => {
    // @ts-expect-error deliberately passing a number to prove it is rejected
    expect(() => toMinorUnits(1.5, 6, "reject")).toThrow(/Floating-point/);
  });

  it("reject policy throws on inexact input but accepts exact", () => {
    expect(() => toMinorUnits("1.005", 2, "reject")).toThrow(RoundingRequiredError);
    expect(toMinorUnits("1.50", 2, "reject")).toBe(150n);
    expect(toMinorUnits("1.500", 2, "reject")).toBe(150n); // trailing zeros are exact
  });

  it("floor and ceil round in the right direction for both signs", () => {
    expect(toMinorUnits("1.005", 2, "floor")).toBe(100n);
    expect(toMinorUnits("1.005", 2, "ceil")).toBe(101n);
    expect(toMinorUnits("-1.005", 2, "floor")).toBe(-101n);
    expect(toMinorUnits("-1.005", 2, "ceil")).toBe(-100n);
  });

  it("halfUp rounds halves away from zero", () => {
    expect(toMinorUnits("1.005", 2, "halfUp")).toBe(101n);
    expect(toMinorUnits("1.004", 2, "halfUp")).toBe(100n);
    expect(toMinorUnits("-1.005", 2, "halfUp")).toBe(-101n);
  });

  it("halfEven rounds ties to the even neighbour", () => {
    expect(toMinorUnits("1.005", 2, "halfEven")).toBe(100n); // 100 is even
    expect(toMinorUnits("1.015", 2, "halfEven")).toBe(102n); // 101 -> 102
    expect(toMinorUnits("1.025", 2, "halfEven")).toBe(102n); // 102 stays
  });

  it("rejects overflow past the signed 128-bit range", () => {
    // 2^127 minor units overflow once scaled.
    expect(() => toMinorUnits("170141183460469231731687303715884105728", 0, "reject")).toThrow(
      AmountOverflowError,
    );
  });

  it("formats exactly and can trim trailing zeros for display", () => {
    expect(fromMinorUnits(150n, 2)).toBe("1.50");
    expect(fromMinorUnits(150n, 2, { trimTrailingZeros: true })).toBe("1.5");
    expect(fromMinorUnits(-150n, 2)).toBe("-1.50");
  });
});

describe("legacy asset compatibility adapter (#1521)", () => {
  it("adapts code+issuer and reports the legacy form", () => {
    const seen: string[] = [];
    const d = adaptLegacyAsset(
      { code: "USDC", issuer: ISSUER, decimals: 6, network: TESTNET },
      (info) => seen.push(info.legacyForm),
    );
    expect(d.kind).toBe("issued");
    expect(seen).toEqual(["code_issuer"]);
  });

  it("adapts code+contract", () => {
    const seen: string[] = [];
    adaptLegacyAsset(
      { code: "USDC", contractId: SAC, decimals: 6, network: TESTNET },
      (info) => seen.push(info.legacyForm),
    );
    expect(seen).toEqual(["code_contract"]);
  });

  it("adapts native XLM without an issuer", () => {
    const d = adaptLegacyAsset({ code: "XLM", network: MAINNET });
    expect(d.kind).toBe("native");
    expect(d.decimals).toBe(7);
  });

  it("rejects a display symbol used as identity", () => {
    expect(() => adaptLegacyAsset({ symbol: "$", network: TESTNET })).toThrow(
      AmbiguousLegacyAssetError,
    );
  });

  it("rejects an issued asset with neither issuer nor contract", () => {
    expect(() => adaptLegacyAsset({ code: "USDC", network: TESTNET })).toThrow(
      /ambiguous/,
    );
  });

  it("rejects an issued asset without explicit decimals", () => {
    expect(() =>
      adaptLegacyAsset({ code: "USDC", issuer: ISSUER, network: TESTNET }),
    ).toThrow(/decimals must be explicit/);
  });

  it("rejects a missing network", () => {
    expect(() => adaptLegacyAsset({ code: "XLM" })).toThrow(/network/);
  });
});
