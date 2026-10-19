/**
 * Unit coverage for the pure staking-position math and config resolver
 * (#1510). No SDK/IO imports, so it runs without the Mongo/Redis harness.
 */
import {
  computeAccruedRewards,
  computeWithdrawable,
  resolveStakingConfig,
} from "../../src/services/stakingPositionMath";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("transferable staking math (#1510)", () => {
  it("first depositor: shares equal the deposit, withdrawable equals principal", () => {
    // 100 staked, 100 shares minted one-for-one.
    expect(computeWithdrawable(100n, 100n, 100n)).toBe(100n);
    expect(computeAccruedRewards(100n, 100n)).toBe(0n);
  });

  it("zero-share rounding truncates down (contract semantics)", () => {
    // 3 shares of a 2-token / 3-share pool = 2 (floor), never 2.5.
    expect(computeWithdrawable(1n, 2n, 3n)).toBe(0n);
    expect(computeWithdrawable(3n, 2n, 3n)).toBe(2n);
  });

  it("reward distribution increases withdrawable above principal", () => {
    // 100 principal, 1 free reward token added to the pool: 100 staked, 200 total, 100 shares... 
    const withdrawable = computeWithdrawable(100n, 150n, 100n);
    expect(withdrawable).toBe(150n);
    expect(computeAccruedRewards(100n, withdrawable)).toBe(50n);
  });

  it("partial withdrawal leaves remaining shares pro-rata", () => {
    // After withdrawing half, the remaining 50 shares of 1000/100 pool = 500.
    expect(computeWithdrawable(50n, 1000n, 100n)).toBe(500n);
  });

  it("returns zero when the pool has no shares or the staker has none", () => {
    expect(computeWithdrawable(0n, 1000n, 100n)).toBe(0n);
    expect(computeWithdrawable(10n, 0n, 0n)).toBe(0n);
  });

  it("never reports negative accrued rewards", () => {
    expect(computeAccruedRewards(150n, 100n)).toBe(0n);
    expect(computeAccruedRewards(100n, 100n)).toBe(0n);
  });
});

describe("staking config resolver (#1510)", () => {
  const base = { SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015" };

  it("defaults decimals to 7 and contractId to null when unset", () => {
    const cfg = resolveStakingConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.contractId).toBeNull();
    expect(cfg.decimals).toBe(7);
    expect(cfg.network).toBe("Test SDF Network ; September 2015");
  });

  it("accepts a valid contract id and explicit decimals", () => {
    const cfg = resolveStakingConfig({
      ...base,
      STAKING_CONTRACT_ID: CONTRACT,
      STAKING_ASSET_DECIMALS: "6",
    } as NodeJS.ProcessEnv);
    expect(cfg.contractId).toBe(CONTRACT);
    expect(cfg.decimals).toBe(6);
  });

  it("throws on a malformed contract id rather than treating it as unset", () => {
    expect(() =>
      resolveStakingConfig({ ...base, STAKING_CONTRACT_ID: "not-a-contract" } as NodeJS.ProcessEnv),
    ).toThrow(/STAKING_CONTRACT_ID/);
  });

  it("throws on out-of-range decimals", () => {
    expect(() =>
      resolveStakingConfig({ ...base, STAKING_ASSET_DECIMALS: "19" } as NodeJS.ProcessEnv),
    ).toThrow(/STAKING_ASSET_DECIMALS/);
  });
});
