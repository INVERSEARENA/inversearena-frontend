import { test, mock, afterEach, describe } from "node:test";
import assert from "node:assert";
import { Request } from "express";
import { ApiKeyAuthProvider } from "../src/middleware/auth";

const VALID_KEY = "a-32-character-long-admin-api-key!!";

function fakeRequest(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as Request;
}

describe("ApiKeyAuthProvider", () => {
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    mock.reset();
  });

  describe("constructor", () => {
    test("throws when ADMIN_API_KEY is not set", () => {
      assert.throws(() => new ApiKeyAuthProvider(), {
        message: "ADMIN_API_KEY environment variable is required",
      });
    });

    test("throws when ADMIN_API_KEY is shorter than 32 characters", () => {
      process.env.ADMIN_API_KEY = "too-short";
      assert.throws(() => new ApiKeyAuthProvider(), {
        message: /at least 32 characters/,
      });
    });

    test("does not throw when ADMIN_API_KEY is 32+ characters", () => {
      process.env.ADMIN_API_KEY = VALID_KEY;
      assert.doesNotThrow(() => new ApiKeyAuthProvider());
    });
  });

  describe("isAdmin", () => {
    test("returns true for the correct key", async () => {
      process.env.ADMIN_API_KEY = VALID_KEY;
      const provider = new ApiKeyAuthProvider();
      const req = fakeRequest(`Bearer ${VALID_KEY}`);
      const result = await provider.isAdmin(req);
      assert.strictEqual(result, true);
    });

    test("returns false for an incorrect key", async () => {
      process.env.ADMIN_API_KEY = VALID_KEY;
      const provider = new ApiKeyAuthProvider();
      const req = fakeRequest("Bearer wrong-key-with-same-length-12345");
      const result = await provider.isAdmin(req);
      assert.strictEqual(result, false);
    });

    test("returns false for mismatched-length token without throwing", async () => {
      process.env.ADMIN_API_KEY = VALID_KEY;
      const provider = new ApiKeyAuthProvider();
      const req = fakeRequest("Bearer short");
      const result = await provider.isAdmin(req);
      assert.strictEqual(result, false);
    });

    test("returns false for empty token without throwing", async () => {
      process.env.ADMIN_API_KEY = VALID_KEY;
      const provider = new ApiKeyAuthProvider();
      const req = fakeRequest("Bearer ");
      const result = await provider.isAdmin(req);
      assert.strictEqual(result, false);
    });

    test("returns false when there is no Authorization header", async () => {
      process.env.ADMIN_API_KEY = VALID_KEY;
      const provider = new ApiKeyAuthProvider();
      const req = fakeRequest();
      const result = await provider.isAdmin(req);
      assert.strictEqual(result, false);
    });
  });
});
