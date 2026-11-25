/**
 * Shared security-header building blocks (#1296).
 *
 * The previous CSP used `script-src 'self' 'unsafe-inline'` (in both
 * `next.config.ts` and `src/proxy.ts`), which lets any injected inline
 * <script> execute and defeats the main XSS mitigation a CSP exists to
 * provide. The header set also omitted Strict-Transport-Security.
 *
 * `src/proxy.ts` now builds `script-src` per request with a random nonce plus
 * 'strict-dynamic' and no 'unsafe-inline', and adds HSTS. `next.config.ts`
 * applies the static (non-CSP) headers below, including HSTS, to every route
 * — covering the static-asset responses `proxy.ts` does not run on.
 */

/**
 * HSTS: 2 years, subdomains, preload-list eligible. A wallet-signing dApp
 * must instruct browsers to refuse plaintext HTTP so a downgrade / MITM
 * cannot intercept transaction data.
 */
export const HSTS_HEADER_VALUE = "max-age=63072000; includeSubDomains; preload";

/**
 * Security headers that do not vary per request, applied via `next.config.ts`
 * `headers()`. The Content-Security-Policy is intentionally NOT here — it
 * carries a per-request nonce and is set by `src/proxy.ts`.
 */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: HSTS_HEADER_VALUE },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * A cryptographically-random nonce as base64. Uses only Web Crypto + btoa so
 * it runs in the Edge (proxy) runtime.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
