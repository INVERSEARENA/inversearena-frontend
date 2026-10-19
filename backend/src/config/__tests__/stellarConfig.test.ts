import {
  NATIVE_ASSET_CODE,
  parseAssetIssuers,
} from "../../config/stellarConfig";

const ISSUER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER_B = `G${"B".repeat(54)}5`;

describe("parseAssetIssuers", () => {
  it("parses comma-separated CODE:ISSUER pairs", () => {
    const issuers = parseAssetIssuers(`USDC:${ISSUER_A}, EURC:${ISSUER_B}`);

    expect(issuers).toEqual({ USDC: ISSUER_A, EURC: ISSUER_B });
  });

  it("treats an unset value as no configured credit assets", () => {
    expect(parseAssetIssuers(undefined)).toEqual({});
    expect(parseAssetIssuers("")).toEqual({});
    expect(parseAssetIssuers("   ")).toEqual({});
  });

  it("rejects a pair with no separator rather than guessing the code", () => {
    // Guessing here would mean guessing an account too, which is worse.
    expect(() => parseAssetIssuers(`USDC${ISSUER_A}`)).toThrow(/CODE:ISSUER/);
  });

  it("rejects an entry with an empty issuer", () => {
    // A trailing `USDC:` must not be read as "no issuer configured"; that is
    // indistinguishable from a wallet that holds nothing.
    expect(() => parseAssetIssuers("USDC:")).toThrow();
  });

  it("rejects a malformed issuer account id", () => {
    expect(() => parseAssetIssuers("USDC:not-an-account")).toThrow();
    // Valid base32, wrong length.
    expect(() => parseAssetIssuers(`USDC:${ISSUER_A.slice(0, 40)}`)).toThrow();
  });

  it("rejects a code that cannot exist on Stellar", () => {
    // Codes are 1-5 characters and may not start with a digit.
    expect(() => parseAssetIssuers(`1USDC:${ISSUER_A}`)).toThrow();
    expect(() => parseAssetIssuers(`TOOLONG:${ISSUER_A}`)).toThrow();
  });

  it("rejects an issuer for the native asset", () => {
    expect(() => parseAssetIssuers(`${NATIVE_ASSET_CODE}:${ISSUER_A}`)).toThrow(/native/);
  });
});
