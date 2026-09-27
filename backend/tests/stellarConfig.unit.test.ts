import { getStellarConfig } from "../src/config/stellarConfig";

describe("getStellarConfig", () => {
  test("rejects missing Stellar settings outside tests", () => {
    expect(() => getStellarConfig({ NODE_ENV: "production" })).toThrow();
  });

  test("allows explicit production settings", () => {
    expect(
      getStellarConfig({
        NODE_ENV: "production",
        SOROBAN_RPC_URL: "https://rpc.example.com",
        STELLAR_NETWORK_PASSPHRASE: "Production network passphrase",
      }),
    ).toEqual({
      sorobanRpcUrl: "https://rpc.example.com",
      networkPassphrase: "Production network passphrase",
      roundConfirmPollMs: 2500,
      roundConfirmMaxPolls: 20,
      assetIssuers: {},
    });
  });

  test("uses testnet defaults only in the test environment", () => {
    expect(getStellarConfig({ NODE_ENV: "test" })).toEqual({
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      roundConfirmPollMs: 2500,
      roundConfirmMaxPolls: 20,
      assetIssuers: {},
    });
  });

  test("exposes configured credit-asset issuers", () => {
    const issuer = `G${"A".repeat(55)}`;
    const config = getStellarConfig({
      SOROBAN_RPC_URL: "https://rpc.example.com",
      STELLAR_NETWORK_PASSPHRASE: "Production network passphrase",
      ASSET_ISSUERS: `USDC:${issuer}`,
    });

    expect(config.assetIssuers).toEqual({ USDC: issuer });
  });

  test("fails at boot on a malformed ASSET_ISSUERS entry", () => {
    // A silently dropped issuer is indistinguishable from a wallet holding
    // nothing, so this must not degrade quietly.
    expect(() =>
      getStellarConfig({
        SOROBAN_RPC_URL: "https://rpc.example.com",
        STELLAR_NETWORK_PASSPHRASE: "Production network passphrase",
        ASSET_ISSUERS: "USDC",
      }),
    ).toThrow();
  });
});
