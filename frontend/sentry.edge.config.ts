/**
 * Sentry Edge Runtime SDK initialisation.
 *
 * Picked up automatically by @sentry/nextjs for middleware and edge routes.
 * Kept minimal — the Edge Runtime does not support Node.js APIs, so only
 * lightweight Sentry features are enabled here.
 *
 * Required environment variable:
 *   NEXT_PUBLIC_SENTRY_DSN – Your Sentry project DSN.
 *                            SDK is disabled (no-ops) when this is absent.
 */

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // No-op when DSN is not configured (safe for local dev / preview deploys).
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),

  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,

  tracesSampleRate: 0.1,

  // Session Replay is not available in the Edge Runtime.
});
