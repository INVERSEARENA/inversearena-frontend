import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

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
  // Suppress the Sentry CLI output during builds unless CI=true.
  silent: !process.env.CI,

  // Upload source maps so stack traces in the dashboard show original
  // TypeScript source instead of minified output.
  // Requires SENTRY_AUTH_TOKEN (server-side only, never exposed to the browser).
  widenClientFileUpload: true,

  // Automatically tree-shake Sentry logger statements in production builds.
  disableLogger: true,
});
