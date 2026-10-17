import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs";

import { STATIC_SECURITY_HEADERS } from "./src/lib/csp";
import { detectLeakedSecrets } from "./src/config/env";

// Build fails immediately if any secret-looking variable is prefixed with NEXT_PUBLIC_ (#1650)
const leakedSecrets = detectLeakedSecrets(process.env);
if (leakedSecrets.length > 0) {
  throw new Error(
    `Security Error: Build failed because secret-looking variable(s) are exposed via NEXT_PUBLIC_:\n${leakedSecrets
      .map((k) => `  - ${k}`)
      .join("\n")}\nNever expose server secrets to the client bundle!`
  );
}

const projectRoot = dirname(fileURLToPath(import.meta.url));

// The Content-Security-Policy is NOT set here: it carries a per-request nonce
// (`script-src` has no 'unsafe-inline') and is emitted by src/proxy.ts.
// Everything else — including Strict-Transport-Security — is static. (#1296)
const securityHeaders = STATIC_SECURITY_HEADERS.map((header) => ({ ...header }));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    root: projectRoot,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Suppress Sentry CLI output during builds unless running in CI.
  silent: !process.env.CI,

  // Upload source maps so Sentry shows original TypeScript in stack traces.
  // Requires SENTRY_AUTH_TOKEN (server-only; never exposed to the browser).
  widenClientFileUpload: true,

  webpack: {
    // Do not wrap Next.js middleware/proxy. src/proxy.ts sets CORS + the
    // security headers, including the CSP nonce (#1296); Sentry's auto-wrap
    // previously caused MIDDLEWARE_INVOCATION_FAILED on Vercel Edge.
    autoInstrumentMiddleware: false,

    // Disable automatic Vercel Cron monitors — not used in this project.
    automaticVercelMonitors: false,
  },
});
