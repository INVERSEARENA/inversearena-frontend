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
    });
  });

  test("uses testnet defaults only in the test environment", () => {
    expect(getStellarConfig({ NODE_ENV: "test" })).toEqual({
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
  });
});
