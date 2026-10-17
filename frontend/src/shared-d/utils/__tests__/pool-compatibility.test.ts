import {
  checkPoolCompatibility,
  filterCompatibleVaults,
  getCompatibleCurrencies,
  type VaultConfig,
} from "../pool-compatibility";
import {
  userMessageForFactoryPanicCode,
  FACTORY_PANIC_USER_MESSAGES,
} from "../contract-error-registry";

describe("Pool compatibility validation (#1634)", () => {
  const tokenUSDC = "C_USDC_TOKEN_ADDRESS";
  const tokenXLM = "C_XLM_TOKEN_ADDRESS";
  const oracleA = "C_ORACLE_A_ADDRESS";
  const oracleB = "C_ORACLE_B_ADDRESS";
  const vault1: VaultConfig = {
    address: "C_VAULT_1_ADDRESS",
    stakeToken: tokenUSDC,
    oracleContract: oracleA,
  };

  it("accepts compatible pool configuration where vault, token, and oracle match", () => {
    const result = checkPoolCompatibility({
      stakeToken: tokenUSDC,
      yieldVault: vault1.address,
      oracleContract: oracleA,
      vaultConfig: vault1,
    });
    expect(result.compatible).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects VaultTokenMismatch when vault stake token does not match pool stake token", () => {
    const result = checkPoolCompatibility({
      stakeToken: tokenXLM, // mismatch! Vault expects USDC
      yieldVault: vault1.address,
      oracleContract: oracleA,
      vaultConfig: vault1,
    });
    expect(result.compatible).toBe(false);
    expect(result.error).toBe("VaultTokenMismatch");
    expect(result.message).toContain("does not support this stake token");
  });

  it("rejects OracleMismatch when pool oracle does not match vault oracle", () => {
    const result = checkPoolCompatibility({
      stakeToken: tokenUSDC,
      yieldVault: vault1.address,
      oracleContract: oracleB, // mismatch! Vault expects oracleA
      vaultConfig: vault1,
    });
    expect(result.compatible).toBe(false);
    expect(result.error).toBe("OracleMismatch");
    expect(result.message).toContain("does not match the yield vault oracle");
  });

  it("rejects unsupported tokens when supportedTokens list is supplied", () => {
    const result = checkPoolCompatibility({
      stakeToken: "C_UNKNOWN_TOKEN",
      yieldVault: vault1.address,
      oracleContract: oracleA,
      supportedTokens: [tokenUSDC, tokenXLM],
    });
    expect(result.compatible).toBe(false);
    expect(result.error).toBe("UnsupportedToken");
  });

  it("rejects unapproved vaults when approvedVaults list is supplied", () => {
    const result = checkPoolCompatibility({
      stakeToken: tokenUSDC,
      yieldVault: "C_UNAPPROVED_VAULT",
      oracleContract: oracleA,
      approvedVaults: [vault1.address],
    });
    expect(result.compatible).toBe(false);
    expect(result.error).toBe("InvalidVault");
  });

  it("filters compatible vaults matching the selected stake token and oracle", () => {
    const vaults: VaultConfig[] = [
      vault1,
      {
        address: "C_VAULT_2_ADDRESS",
        stakeToken: tokenXLM,
        oracleContract: oracleA,
      },
      {
        address: "C_VAULT_3_ADDRESS",
        stakeToken: tokenUSDC,
        oracleContract: oracleB,
      },
    ];

    const usdcVaults = filterCompatibleVaults(vaults, tokenUSDC);
    expect(usdcVaults).toHaveLength(2);
    expect(usdcVaults.map((v) => v.address)).toEqual([
      "C_VAULT_1_ADDRESS",
      "C_VAULT_3_ADDRESS",
    ]);

    const usdcOracleAVaults = filterCompatibleVaults(vaults, tokenUSDC, oracleA);
    expect(usdcOracleAVaults).toHaveLength(1);
    expect(usdcOracleAVaults[0]?.address).toBe("C_VAULT_1_ADDRESS");
  });

  it("identifies compatible currencies that have at least one active vault", () => {
    const available = [
      { code: "USDC", contractId: tokenUSDC },
      { code: "XLM", contractId: tokenXLM },
      { code: "EURC", contractId: "C_EURC" },
    ];
    const compatible = getCompatibleCurrencies(available, [vault1]);
    expect(compatible).toEqual(["USDC"]);
  });

  it("maps factory panic codes 21 and 22 to descriptive user messages", () => {
    expect(userMessageForFactoryPanicCode(21)).toContain(
      "The selected yield vault does not support this stake token",
    );
    expect(userMessageForFactoryPanicCode(22)).toContain(
      "The selected oracle does not match the yield vault oracle",
    );
    expect(FACTORY_PANIC_USER_MESSAGES[21]).toBe(
      "The selected yield vault does not support this stake token.",
    );
    expect(FACTORY_PANIC_USER_MESSAGES[22]).toBe(
      "The selected oracle does not match the yield vault oracle.",
    );
  });
});
