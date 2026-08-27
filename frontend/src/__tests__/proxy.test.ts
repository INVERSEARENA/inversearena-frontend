/**
 * @jest-environment node
 */
/**
 * Regression tests for #1296 (dynamic half).
 *
 * `script-src 'self' 'unsafe-inline'` let any injected inline <script> run,
 * defeating the CSP's primary purpose, and there was no Strict-Transport-
 * Security header. src/proxy.ts now emits a per-request nonce'd CSP with no
 * 'unsafe-inline' in script-src, plus HSTS.
 */
import { NextRequest } from "next/server";

import { proxy } from "../proxy";

function scriptSrcOf(csp: string): string {
  const directive = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "));
  if (!directive) throw new Error(`no script-src in CSP: ${csp}`);
  return directive;
}

function run(path = "/dashboard/profile") {
  const res = proxy(new NextRequest(`http://localhost${path}`));
  const csp = res.headers.get("content-security-policy") ?? "";
  return { res, csp, scriptSrc: scriptSrcOf(csp) };
}

describe("proxy() CSP hardening (#1296)", () => {
  it("script-src has no 'unsafe-inline' — an injected inline <script> cannot run", () => {
    const { scriptSrc } = run();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("script-src is nonce-based with 'strict-dynamic'", () => {
    const { scriptSrc } = run();
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("issues a fresh nonce per request", () => {
    const first = run().scriptSrc.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    const second = run().scriptSrc.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("forwards the same nonce to the app as x-nonce (so rendered scripts match the header)", () => {
    const { res, scriptSrc } = run();
    const headerNonce = scriptSrc.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    // Next encodes overridden request headers onto the response.
    const forwarded = res.headers.get("x-middleware-request-x-nonce");
    if (forwarded !== null) {
      expect(forwarded).toBe(headerNonce);
    }
  });

  it("adds Strict-Transport-Security", () => {
    const { res } = run();
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("keeps the other directives (connect-src for Stellar/Horizon, frame-ancestors, object-src)", () => {
    const { csp } = run();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/connect-src [^;]*stellar\.org/);
  });
});
