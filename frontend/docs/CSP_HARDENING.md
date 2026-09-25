# CSP Hardening — Issue #1451

## Ownership

The Content-Security-Policy is assembled per request in `src/proxy.ts`
(`buildCsp`). Static (non-nonce) security headers live in
`src/lib/csp.ts` (`STATIC_SECURITY_HEADERS`) and are re-applied by
`next.config.ts` to cover static-asset responses the proxy middleware
does not reach.

## State transitions

| State | Description |
|-------|-------------|
| Before #1451 | `style-src 'unsafe-inline'` (no nonce on styles); `img-src … https:` (any HTTPS host); no `worker-src`; no `manifest-src` |
| After #1451 | `style-src` carries per-request nonce + `'unsafe-inline'` fallback for pre-CSP3; `img-src` restricted to an explicit allowlist; `worker-src 'self' blob:`; `manifest-src 'self'` |

## Compatibility

- `style-src 'unsafe-inline'` is intentionally retained alongside the
  nonce. CSP3 browsers honour the nonce and ignore `'unsafe-inline'`
  when a nonce is present; older browsers fall back to the unsafe-inline
  flag. Removing it entirely would break pre-CSP3 clients.
- `worker-src blob:` is required by the Stellar SDK and some wallet
  connectors that create workers dynamically via `new Worker(blob)`.
- `manifest-src 'self'` has no user-visible impact; it restricts which
  document can be declared as the installed PWA manifest, preventing
  cross-origin manifest substitution.

## Failure behaviour

A CSP violation is a browser-side enforcement decision: the violating
resource is blocked by the browser and the page continues to run. No
server state changes on violation. Violations can be observed via
browser devtools or a `report-to` endpoint (future work).

## Observability

Security headers are set synchronously on every response in
`applySecurityHeaders`. The nonce value is forwarded as `x-nonce` on
the overridden request headers so the root layout can pass it to
next-themes for its inline anti-flash script.
