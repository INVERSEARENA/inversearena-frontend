import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { issueSignedServerTime, verifySignedServerTime } from "../src/services/serverTimeService";
import { SecretConfigError } from "../src/config/secretKeyring";

const CURRENT = "a".repeat(32);
const PREVIOUS = "b".repeat(32);

function clearJwtEnv() {
  for (const key of Object.keys(process.env)) if (key.startsWith("JWT_SECRET")) delete process.env[key];
}

function future(msFromNow = 24 * 60 * 60 * 1000): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

describe("serverTimeService", () => {
  beforeEach(() => {
    clearJwtEnv();
    process.env.JWT_SECRET = CURRENT;
  });

  afterEach(() => {
    clearJwtEnv();
  });

  describe("issueSignedServerTime", () => {
    it("issues a token embedding the given time", () => {
      const now = Date.parse("2026-06-01T00:00:00.000Z");
      const result = issueSignedServerTime(now);

      expect(result.serverTimeMs).toBe(now);
      expect(result.issuedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(typeof result.token).toBe("string");
    });

    it("throws (via the shared JWT keyring's own fatal-misconfiguration check) when no JWT secret is configured", () => {
      // JWT_SECRET is the required purpose (unlike webhook, which is
      // optional), so getKeyring itself throws SecretConfigError rather
      // than returning null here — this is the existing, shared
      // fail-loudly-at-boot behavior for every JWT consumer, not something
      // serverTimeService overrides.
      clearJwtEnv();
      expect(() => issueSignedServerTime()).toThrow(SecretConfigError);
    });
  });

  describe("verifySignedServerTime", () => {
    it("verifies a token issued by the current key", () => {
      const now = Date.parse("2026-06-01T00:00:00.000Z");
      const { token } = issueSignedServerTime(now);

      const result = verifySignedServerTime(token);

      expect(result).toEqual({ ok: true, serverTimeMs: now });
    });

    it("rejects a malformed token", () => {
      const result = verifySignedServerTime("not-a-jwt");
      expect(result.ok).toBe(false);
    });

    it("rejects a token signed with a different secret", () => {
      const { token } = issueSignedServerTime();

      clearJwtEnv();
      process.env.JWT_SECRET = "c".repeat(32);

      const result = verifySignedServerTime(token);
      expect(result).toEqual({ ok: false, reason: "unknown_kid" });
    });

    it("accepts a token signed with the previous key during the rotation overlap window", () => {
      process.env.JWT_SECRET_PREVIOUS = PREVIOUS;
      process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = future();
      const { token } = issueSignedServerTime();

      // Rotate: previous key becomes CURRENT's replacement source, but the
      // token was signed under the old current key, now demoted to previous.
      clearJwtEnv();
      process.env.JWT_SECRET = "d".repeat(32);
      process.env.JWT_SECRET_PREVIOUS = CURRENT;
      process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = future();

      const result = verifySignedServerTime(token);
      expect(result.ok).toBe(true);
    });

    it("rejects a token whose previous-key overlap window has expired", () => {
      process.env.JWT_SECRET_PREVIOUS = PREVIOUS;
      process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = future();
      const { token } = issueSignedServerTime();

      clearJwtEnv();
      process.env.JWT_SECRET = "d".repeat(32);
      process.env.JWT_SECRET_PREVIOUS = CURRENT;
      process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();

      const result = verifySignedServerTime(token);
      expect(result.ok).toBe(false);
    });
  });
});
