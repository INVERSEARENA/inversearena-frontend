import { Address, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import {
  assertPoolCompatible,
  compatibleCurrencies,
  parseVaultConfigFromScVal,
  type CurrencyTokenIds,
} from "@/shared/lib/stellar/pool-compatibility";

const contractId = (seed: number) => StrKey.encodeContract(Buffer.alloc(32, seed));

const USDC = contractId(1);
const XLM = contractId(2);
const ORACLE = contractId(3);
const OTHER_ORACLE = contractId(4);
const tokenIds: CurrencyTokenIds = { USDC, XLM };

describe("pool compatibility (#1634)", () => {
  it("decodes the RWA adapter's VaultConfig", () => {
    const retval = nativeToScVal({
      oracle: new Address(ORACLE),
      stake_token: new Address(USDC),
    });
    expect(parseVaultConfigFromScVal(retval)).toEqual({ stakeToken: USDC, oracle: ORACLE });
  });

  it("rejects a config read with an unexpected shape", () => {
    expect(() => parseVaultConfigFromScVal(nativeToScVal(7))).toThrow(/unexpected shape/);
  });

  it("offers only the currency the vault holds", () => {
    expect(compatibleCurrencies({ stakeToken: USDC, oracle: ORACLE }, tokenIds, ORACLE)).toEqual([
      "USDC",
    ]);
    expect(compatibleCurrencies({ stakeToken: XLM, oracle: ORACLE }, tokenIds, ORACLE)).toEqual([
      "XLM",
    ]);
  });

  it("offers nothing when the vault holds a token the app does not know", () => {
    expect(
      compatibleCurrencies({ stakeToken: contractId(9), oracle: ORACLE }, tokenIds, ORACLE),
    ).toEqual([]);
  });

  it("offers nothing when the vault accrues from a different oracle", () => {
    expect(
      compatibleCurrencies({ stakeToken: USDC, oracle: OTHER_ORACLE }, tokenIds, ORACLE),
    ).toEqual([]);
  });

  it("refuses to build an incompatible pool", () => {
    const vault = { stakeToken: USDC, oracle: ORACLE };
    expect(() => assertPoolCompatible(vault, "USDC", tokenIds, ORACLE)).not.toThrow();
    expect(() => assertPoolCompatible(vault, "XLM", tokenIds, ORACLE)).toThrow(
      /does not hold XLM/,
    );
    expect(() => assertPoolCompatible(vault, "USDC", tokenIds, OTHER_ORACLE)).toThrow(
      /oracle does not match/,
    );
  });
});
