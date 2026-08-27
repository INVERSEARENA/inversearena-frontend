/**
 * Regression tests for #1296 (static half).
 *
 * The security header set used to omit Strict-Transport-Security entirely,
 * and the CSP lived as a static string with `script-src 'self'
 * 'unsafe-inline'`. HSTS is now part of the static header set; the CSP is
 * built per request in src/proxy.ts (see proxy.test.ts).
 */
import {
  HSTS_HEADER_VALUE,
  STATIC_SECURITY_HEADERS,
  generateNonce,
} from "@/lib/csp";

describe("STATIC_SECURITY_HEADERS (#1296)", () => {
  it("includes Strict-Transport-Security with a 2-year max-age, subdomains and preload", () => {
    const hsts = STATIC_SECURITY_HEADERS.find(
      (h) => h.key.toLowerCase() === "strict-transport-security",
    );
    expect(hsts).toBeDefined();
    expect(hsts?.value).toBe("max-age=63072000; includeSubDomains; preload");
    expect(HSTS_HEADER_VALUE).toBe(hsts?.value);
  });

  it("does NOT carry a static Content-Security-Policy (it is per-request now)", () => {
    const csp = STATIC_SECURITY_HEADERS.find(
      (h) => h.key.toLowerCase() === "content-security-policy",
    );
    expect(csp).toBeUndefined();
  });

  it("still carries the other baseline headers", () => {
    const keys = STATIC_SECURITY_HEADERS.map((h) => h.key.toLowerCase());
    expect(keys).toEqual(
      expect.arrayContaining([
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
        "permissions-policy",
      ]),
    );
  });
});

describe("generateNonce (#1296)", () => {
  it("returns a fresh, non-trivial base64 nonce each call", () => {
    const a = generateNonce();
    const b = generateNonce();

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // 16 random bytes → 24 base64 chars.
    expect(Buffer.from(a, "base64")).toHaveLength(16);
  });
});
