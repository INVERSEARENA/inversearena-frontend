import {
  clientEnvSchema,
  serverEnvSchema,
  detectLeakedSecrets,
  validateFrontendEnv,
} from "../env";

describe("Frontend Environment Schema & Secret Leak Detection", () => {
  const validClientEnv = {
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
    NEXT_PUBLIC_FACTORY_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    NEXT_PUBLIC_USDC_CONTRACT_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  };

  describe("detectLeakedSecrets", () => {
    it("detects secret variables prefixed with NEXT_PUBLIC_", () => {
      const env = {
        NEXT_PUBLIC_ADMIN_SECRET: "my-secret",
        NEXT_PUBLIC_API_KEY: "secret-key-123",
        NEXT_PUBLIC_AUTH_TOKEN: "jwt-token",
        NEXT_PUBLIC_PRIVATE_KEY: "s-private-key",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      };

      const leaked = detectLeakedSecrets(env);
      expect(leaked).toContain("NEXT_PUBLIC_ADMIN_SECRET");
      expect(leaked).toContain("NEXT_PUBLIC_API_KEY");
      expect(leaked).toContain("NEXT_PUBLIC_AUTH_TOKEN");
      expect(leaked).toContain("NEXT_PUBLIC_PRIVATE_KEY");
      expect(leaked).not.toContain("NEXT_PUBLIC_SOROBAN_RPC_URL");
    });

    it("returns empty array when no secrets are leaked", () => {
      const leaked = detectLeakedSecrets(validClientEnv);
      expect(leaked).toEqual([]);
    });
  });

  describe("clientEnvSchema", () => {
    it("validates valid client environment", () => {
      const parsed = clientEnvSchema.parse(validClientEnv);
      expect(parsed.NEXT_PUBLIC_STELLAR_NETWORK).toBe("testnet");
      expect(parsed.NEXT_PUBLIC_SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    });

    it("fails when required client variables are missing", () => {
      const result = clientEnvSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues.map((i) => i.path.join("."));
        expect(issues).toContain("NEXT_PUBLIC_SOROBAN_RPC_URL");
        expect(issues).toContain("NEXT_PUBLIC_HORIZON_URL");
        expect(issues).toContain("NEXT_PUBLIC_FACTORY_CONTRACT_ID");
        expect(issues).toContain("NEXT_PUBLIC_USDC_CONTRACT_ID");
      }
    });

    it("defaults NEXT_PUBLIC_STELLAR_NETWORK to testnet", () => {
      const parsed = clientEnvSchema.parse(validClientEnv);
      expect(parsed.NEXT_PUBLIC_STELLAR_NETWORK).toBe("testnet");
    });
  });

  describe("serverEnvSchema", () => {
    it("validates valid server environment", () => {
      const parsed = serverEnvSchema.parse({
        REDIS_URL: "redis://localhost:6379",
        ALLOWED_ORIGINS: "http://localhost:3000,http://localhost:3001",
        TRUSTED_PROXY_COUNT: "1",
      });
      expect(parsed.REDIS_URL).toBe("redis://localhost:6379");
      expect(parsed.TRUSTED_PROXY_COUNT).toBe("1");
    });

    it("allows optional server variables to be omitted", () => {
      const parsed = serverEnvSchema.parse({});
      expect(parsed.REDIS_URL).toBeUndefined();
    });
  });

  describe("validateFrontendEnv", () => {
    it("throws immediately if a secret is exposed with NEXT_PUBLIC_", () => {
      expect(() => {
        validateFrontendEnv({
          ...validClientEnv,
          NEXT_PUBLIC_DATABASE_PASSWORD: "leaked_db_password",
        });
      }).toThrow(/Security Error: Secret-looking environment variable\(s\) exposed to client/);
    });

    it("throws readable error listing missing/invalid variables", () => {
      expect(() => {
        validateFrontendEnv({
          NEXT_PUBLIC_SOROBAN_RPC_URL: "not-a-valid-url",
        });
      }).toThrow(/❌ Invalid environment variables:/);
    });

    it("returns parsed environment when valid", () => {
      const result = validateFrontendEnv(validClientEnv, { checkServer: false });
      expect(result.client.NEXT_PUBLIC_STELLAR_NETWORK).toBe("testnet");
    });
  });
});
