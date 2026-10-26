import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";

import { STATIC_SECURITY_HEADERS } from "./src/shared/config/csp";
import { validateBuildEnv } from "./src/shared/config/env/build";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// #1575: next-intl resolves messages via src/i18n/request.ts (locale from
// the NEXT_LOCALE cookie, no locale routing).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

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

const sentryConfig: Parameters<typeof withSentryConfig>[1] = {
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
};

// #1650: every phase fails on a secret-looking NEXT_PUBLIC_ variable. `next build`
// also fails on a missing/malformed one, which `next dev` only warns about.
export default function config(phase: string) {
  validateBuildEnv(process.env, {
    strict: phase === PHASE_PRODUCTION_BUILD,
    warn: phase === PHASE_DEVELOPMENT_SERVER,
  });
  return withNextIntl(withSentryConfig(nextConfig, sentryConfig));
}
