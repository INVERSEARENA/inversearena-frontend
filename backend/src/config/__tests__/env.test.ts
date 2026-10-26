import { ENV_VARS, EnvValidationError, checkEnv, env, processEnv, validateEnv } from "../env";

const CONTRACT = `C${"A".repeat(55)}`;
const ACCOUNT = `G${"A".repeat(55)}`;

/** The smallest environment that boots. */
const valid = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  MONGODB_URI: "mongodb://localhost:27017/db",
  ADMIN_API_KEY: "k".repeat(32),
  JWT_SECRET: "j".repeat(32),
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ARENA_FACTORY_CONTRACT_ID: CONTRACT,
  PAYOUT_CONTRACT_ID: CONTRACT,
  PAYOUT_SOURCE_ACCOUNT: ACCOUNT,
});

describe("validateEnv", () => {
  it("accepts a complete environment", () => {
    expect(() => validateEnv(valid())).not.toThrow();
  });

  it("lists every missing and malformed variable in one error", () => {
    const source = { ...valid(), PORT: "abc", SOROBAN_RPC_URL: "not-a-url" };
    delete source.JWT_SECRET;
    delete source.MONGODB_URI;

    expect(() => validateEnv(source)).toThrow(EnvValidationError);
    try {
      validateEnv(source);
    } catch (error) {
      const issues = (error as EnvValidationError).issues;
      expect(issues.map((issue) => issue.name).sort()).toEqual(["JWT_SECRET", "MONGODB_URI", "PORT", "SOROBAN_RPC_URL"]);
      expect((error as Error).message).toContain("  - PORT: must be an integer");
      expect((error as Error).message).toContain("  - JWT_SECRET: is required but not set");
    }
  });

  it("never echoes a value, which may be a secret", () => {
    const leaked = "super-secret-but-too-short";
    expect(() => validateEnv({ ...valid(), ADMIN_API_KEY: leaked })).toThrow(/ADMIN_API_KEY: must be at least 32 characters/);
    try {
      validateEnv({ ...valid(), ADMIN_API_KEY: leaked });
    } catch (error) {
      expect((error as Error).message).not.toContain(leaked);
    }
  });

  it("rejects the documented placeholder admin key", () => {
    const issues = checkEnv({ ...valid(), ADMIN_API_KEY: "change-me-in-production" });
    expect(issues).toEqual([
      { name: "ADMIN_API_KEY", message: "must be at least 32 characters; must be changed from the default value" },
    ]);
  });

  it("treats an empty value as unset, as dotenv writes `NAME=`", () => {
    expect(checkEnv({ ...valid(), PORT: "", JWT_SECRET: "  " })).toEqual([
      { name: "JWT_SECRET", message: "is required but not set" },
    ]);
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PAYOUTS_LIVE_EXECUTION", "yes"],
    ["PAYOUT_SOURCE_ACCOUNT", CONTRACT],
    ["ADMIN_WALLET_ADDRESSES", `${ACCOUNT},not-an-account`],
    ["ASSET_ISSUERS", "USDC"],
    ["PUSH_ENCRYPTION_KEY", "abc"],
    ["TTL_KEEPER_MANIFESTS", "{}"],
    ["JWT_SECRET_PREVIOUS_EXPIRES_AT", "next tuesday"],
  ])("rejects %s=%s", (name, value) => {
    expect(checkEnv({ ...valid(), [name]: value }).map((issue) => issue.name)).toEqual([name]);
  });

  it.each([
    ["ADMIN_WALLET_ADDRESSES", `${ACCOUNT}, ${ACCOUNT}`],
    ["ASSET_ISSUERS", `USDC:${ACCOUNT},EURC:${ACCOUNT}`],
    ["TTL_KEEPER_MANIFESTS", "[]"],
    ["ADMIN_TOKEN_TTL_SECONDS", "0"],
    ["LOG_LEVEL", "debug"],
  ])("accepts %s=%s", (name, value) => {
    expect(checkEnv({ ...valid(), [name]: value })).toEqual([]);
  });
});

describe("ENV_VARS", () => {
  it("documents every variable", () => {
    for (const [name, spec] of Object.entries(ENV_VARS)) {
      expect({ name, ok: spec.section.length > 0 && spec.description.length > 0 }).toEqual({ name, ok: true });
    }
  });

  it("gives no real-looking example to a secret", () => {
    for (const [name, spec] of Object.entries(ENV_VARS)) {
      if (!("secret" in spec) || !spec.secret || !("example" in spec)) continue;
      expect({ name, example: spec.example }).toEqual({ name, example: expect.stringMatching(/localhost/) });
    }
  });
});

describe("env", () => {
  const original = process.env.LOG_LEVEL;
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  });

  it("reads through to process.env on every access", () => {
    process.env.LOG_LEVEL = "debug";
    expect(env.LOG_LEVEL).toBe("debug");
    process.env.LOG_LEVEL = "warn";
    expect(env.LOG_LEVEL).toBe("warn");
  });

  it("throws on an undeclared name", () => {
    expect(() => (env as Record<string, string | undefined>).NOT_DECLARED).toThrow(
      "Undeclared environment variable NOT_DECLARED",
    );
  });
});

describe("processEnv", () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  it("follows process.env when a test replaces the whole object", () => {
    process.env = { ...original, LOG_LEVEL: "trace" };
    expect(processEnv.LOG_LEVEL).toBe("trace");
    expect("LOG_LEVEL" in processEnv).toBe(true);
    expect({ ...processEnv }.LOG_LEVEL).toBe("trace");
  });
});
