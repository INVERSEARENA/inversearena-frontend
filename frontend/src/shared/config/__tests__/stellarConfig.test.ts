/**
 * Tests for stellarConfig's graceful-fallback behavior (#1134).
 *
 * Previously this module called `.parse()` at import time, so any missing
 * env var crashed the entire Next.js app — including pages with no Stellar
 * dependency at all. Now importing the module must never throw; only
 * actually reading a property off `stellarConfig` while misconfigured
 * throws, matching "throw only when a Soroban-specific operation is
 * actually attempted."
 */

const REQUIRED_KEYS = [
  "NEXT_PUBLIC_SOROBAN_RPC_URL",
  "NEXT_PUBLIC_HORIZON_URL",
  "NEXT_PUBLIC_FACTORY_CONTRACT_ID",
  "NEXT_PUBLIC_USDC_CONTRACT_ID",
] as const;

type Snapshot = Record<(typeof REQUIRED_KEYS)[number], string | undefined>;

function snapshotEnv(): Snapshot {
  return Object.fromEntries(REQUIRED_KEYS.map((k) => [k, process.env[k]])) as Snapshot;
}

function restoreEnv(snapshot: Snapshot) {
  for (const key of REQUIRED_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

describe("stellarConfig", () => {
  let originalEnv: Snapshot;

  beforeEach(() => {
    originalEnv = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    jest.resetModules();
  });

  it("exposes the parsed config when all required env vars are present (baseline from jest.setup.env.ts)", () => {
    let mod!: typeof import("../stellarConfig");
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require("../stellarConfig");
    });

    expect(mod.isStellarConfigured).toBe(true);
    expect(mod.stellarConfigError).toBeNull();
    expect(mod.stellarConfig.sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(mod.stellarConfig.horizonUrl).toBe("https://horizon-testnet.stellar.org");
  });

  it("does NOT throw at import time when required env vars are missing", () => {
    for (const key of REQUIRED_KEYS) delete process.env[key];

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../stellarConfig");
      });
    }).not.toThrow();
  });

  it("reports isStellarConfigured: false and a descriptive error when misconfigured", () => {
    delete process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
    delete process.env.NEXT_PUBLIC_HORIZON_URL;

    let mod!: typeof import("../stellarConfig");
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require("../stellarConfig");
    });

    expect(mod.isStellarConfigured).toBe(false);
    expect(mod.stellarConfigError).toEqual(
      expect.stringContaining("NEXT_PUBLIC_SOROBAN_RPC_URL"),
    );
    expect(mod.stellarConfigError).toEqual(expect.stringContaining("NEXT_PUBLIC_HORIZON_URL"));
  });

  it("throws only when a property is actually read off stellarConfig while misconfigured", () => {
    for (const key of REQUIRED_KEYS) delete process.env[key];

    let mod!: typeof import("../stellarConfig");
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require("../stellarConfig");
    });

    expect(() => mod.stellarConfig.sorobanRpcUrl).toThrow(/not configured/i);
    expect(() => mod.stellarConfig.factoryContractId).toThrow(/not configured/i);
  });
});
