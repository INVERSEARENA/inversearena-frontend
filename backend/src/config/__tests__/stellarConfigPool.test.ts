import { getStellarConfig, parseSorobanRpcUrls } from "../stellarConfig";

describe("stellarConfig multi-provider RPC pool (#1830)", () => {
  it("parses comma-separated SOROBAN_RPC_URLS and deduplicates", () => {
    const urls = parseSorobanRpcUrls(
      "https://rpc-1.example.com/, https://rpc-2.example.com , https://rpc-1.example.com",
      undefined,
    );
    expect(urls).toEqual([
      "https://rpc-1.example.com",
      "https://rpc-2.example.com",
    ]);
  });

  it("falls back to single SOROBAN_RPC_URL when SOROBAN_RPC_URLS is unset", () => {
    const cfg = getStellarConfig({
      NODE_ENV: "test",
      SOROBAN_RPC_URL: "https://single-rpc.example.com/",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    } as NodeJS.ProcessEnv);

    expect(cfg.sorobanRpcUrl).toBe("https://single-rpc.example.com");
    expect(cfg.sorobanRpcUrls).toEqual(["https://single-rpc.example.com"]);
    expect(cfg.sorobanMaxLedgerLag).toBe(5);
  });

  it("reads SOROBAN_RPC_URLS and custom SOROBAN_MAX_LEDGER_LAG", () => {
    const cfg = getStellarConfig({
      NODE_ENV: "test",
      SOROBAN_RPC_URLS: "https://a.example.com,https://b.example.com",
      SOROBAN_MAX_LEDGER_LAG: "12",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    } as NodeJS.ProcessEnv);

    expect(cfg.sorobanRpcUrl).toBe("https://a.example.com");
    expect(cfg.sorobanRpcUrls).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(cfg.sorobanMaxLedgerLag).toBe(12);
  });
});
