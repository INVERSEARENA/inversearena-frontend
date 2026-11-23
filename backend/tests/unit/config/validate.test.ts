import { validateConfig } from "../../src/config/validate";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("validateConfig", () => {
  describe("ADMIN_API_KEY", () => {
    it("throws when ADMIN_API_KEY is the default value", () => {
      process.env.ADMIN_API_KEY = "change-me-in-production";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "0";
      expect(() => validateConfig()).toThrow(
        "ADMIN_API_KEY must be changed from the default value"
      );
    });

    it("throws when ADMIN_API_KEY is shorter than 32 characters", () => {
      process.env.ADMIN_API_KEY = "short-key";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "0";
      expect(() => validateConfig()).toThrow(
        "ADMIN_API_KEY must be at least 32 characters"
      );
    });

    it("passes with a valid 32+ character key", () => {
      process.env.ADMIN_API_KEY = "a-valid-admin-api-key-that-is-long-enough-32";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "0";
      expect(() => validateConfig()).not.toThrow();
    });

    it("throws when ADMIN_API_KEY is empty", () => {
      process.env.ADMIN_API_KEY = "";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "0";
      expect(() => validateConfig()).toThrow(
        "ADMIN_API_KEY must be at least 32 characters"
      );
    });
  });

  describe("ADMIN_TOKEN_TTL_SECONDS", () => {
    it("throws when TTL is between 1 and 299", () => {
      process.env.ADMIN_API_KEY = "a-valid-admin-api-key-that-is-long-enough-32";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "30";
      expect(() => validateConfig()).toThrow(
        "ADMIN_TOKEN_TTL_SECONDS must be at least 300 seconds"
      );
    });

    it("throws when TTL is 1", () => {
      process.env.ADMIN_API_KEY = "a-valid-admin-api-key-that-is-long-enough-32";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "1";
      expect(() => validateConfig()).toThrow(
        "ADMIN_TOKEN_TTL_SECONDS must be at least 300 seconds"
      );
    });

    it("throws when TTL is 299", () => {
      process.env.ADMIN_API_KEY = "a-valid-admin-api-key-that-is-long-enough-32";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "299";
      expect(() => validateConfig()).toThrow(
        "ADMIN_TOKEN_TTL_SECONDS must be at least 300 seconds"
      );
    });

    it("passes with TTL set to 300", () => {
      process.env.ADMIN_API_KEY = "a-valid-admin-api-key-that-is-long-enough-32";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "300";
      expect(() => validateConfig()).not.toThrow();
    });

    it("passes with TTL set to 900", () => {
      process.env.ADMIN_API_KEY = "a-valid-admin-api-key-that-is-long-enough-32";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "900";
      expect(() => validateConfig()).not.toThrow();
    });

    it("passes with TTL set to 0 (API key only, no expiring tokens)", () => {
      process.env.ADMIN_API_KEY = "a-valid-admin-api-key-that-is-long-enough-32";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "0";
      expect(() => validateConfig()).not.toThrow();
    });
  });

  describe("validation order", () => {
    it("reports API key error before TTL error when both are invalid", () => {
      process.env.ADMIN_API_KEY = "short";
      process.env.ADMIN_TOKEN_TTL_SECONDS = "30";
      expect(() => validateConfig()).toThrow(
        "ADMIN_API_KEY must be at least 32 characters"
      );
    });
  });
});
