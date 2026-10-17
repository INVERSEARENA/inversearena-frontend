import {
  backendEnvSchema,
  validateBackendEnv,
  formatBackendEnvErrors,
} from "../env";
import { config, getConfig } from "../index";

describe("Backend Environment Schema & Validation", () => {
  const validBackendEnv = {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/testdb",
    JWT_SECRET: "minimum-32-characters-secret-key-12345",
    ADMIN_API_KEY: "admin-api-key-at-least-32-characters-long",
    ORACLE_WEBHOOK_SECRET: "test-oracle-secret",
    PAYOUT_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    PAYOUT_SOURCE_ACCOUNT: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ARENA_FACTORY_CONTRACT_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  };

  it("successfully parses valid environment with defaults", () => {
    const parsed = validateBackendEnv(validBackendEnv);
    expect(parsed.PORT).toBe(3001);
    expect(parsed.DATABASE_URL).toBe(validBackendEnv.DATABASE_URL);
    expect(parsed.REDIS_URL).toBe("redis://localhost:6379");
    expect(parsed.SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    expect(parsed.PAYOUTS_LIVE_EXECUTION).toBe(false);
  });

  it("fails fast on missing required variables in non-test mode", () => {
    expect(() => {
      validateBackendEnv({
        NODE_ENV: "production",
      });
    }).toThrow(/❌ Backend Environment Configuration Error:/);
  });

  it("rejects invalid contract IDs", () => {
    expect(() => {
      validateBackendEnv({
        ...validBackendEnv,
        PAYOUT_CONTRACT_ID: "invalid-id",
      });
    }).toThrow(/PAYOUT_CONTRACT_ID must be a valid Stellar contract ID/);
  });

  it("rejects short ADMIN_API_KEY (<32 chars)", () => {
    expect(() => {
      validateBackendEnv({
        ...validBackendEnv,
        ADMIN_API_KEY: "too-short",
      });
    }).toThrow(/ADMIN_API_KEY must be at least 32 characters/);
  });

  it("rejects short JWT_SECRET (<32 chars)", () => {
    expect(() => {
      validateBackendEnv({
        ...validBackendEnv,
        JWT_SECRET: "too-short",
      });
    }).toThrow(/JWT_SECRET must be at least 32 characters long/);
  });

  it("formats readable error listing all invalid fields", () => {
    try {
      validateBackendEnv({
        NODE_ENV: "production",
      });
      fail("Expected validation to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("• ADMIN_API_KEY: Required");
      expect(message).toContain("• JWT_SECRET: Required");
      expect(message).toContain("• PAYOUT_CONTRACT_ID: Required");
    }
  });

  it("exposes typed config through the single config module", () => {
    const c = getConfig();
    expect(c).toBeDefined();
    expect(typeof c.PORT).toBe("number");
    expect(config.PORT).toBe(c.PORT);
  });
});
