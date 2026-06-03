import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const cspHeader = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https: blob:",
  "connect-src 'self' https://soroban-testnet.stellar.org https://horizon-testnet.stellar.org wss://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org https://horizon-mainnet.stellar.org https://*.sentry.io https://sentry.io",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspHeader },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

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
    // Do not wrap Next.js middleware — we have no middleware.ts and the
    // auto-wrap causes MIDDLEWARE_INVOCATION_FAILED on Vercel Edge deployments.
    autoInstrumentMiddleware: false,

    // Disable automatic Vercel Cron monitors — not used in this project.
    automaticVercelMonitors: false,
  },
});
