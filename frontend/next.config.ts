import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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
