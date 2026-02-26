/**
 * Sentry client-side SDK initialisation.
 *
 * This file is automatically picked up by @sentry/nextjs when the app starts
 * in the browser.  It must remain at the root of the Next.js project (next to
 * next.config.ts).
 *
 * Required environment variable:
 *   NEXT_PUBLIC_SENTRY_DSN  – Your project DSN from the Sentry dashboard.
 *                             Without this the SDK stays disabled; no errors
 *                             are reported and no network traffic is generated.
 *
 * Optional:
 *   NEXT_PUBLIC_SENTRY_ENVIRONMENT – defaults to NODE_ENV ("production", etc.)
 *   NEXT_PUBLIC_SENTRY_RELEASE     – set by CI to the git SHA / semver tag.
 */

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only active when a DSN is provided.  The SDK no-ops when dsn is undefined.
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),

  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,

  // Capture 10 % of transactions for performance monitoring.  Adjust or set
  // to 0 to disable performance tracing entirely.
  tracesSampleRate: 0.1,

  // Replay 5 % of all sessions and 100 % of sessions with errors.
  // Remove the integration below if Session Replay is not needed.
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1.0,

  integrations: [Sentry.replayIntegration()],

  // ── Privacy / PII ────────────────────────────────────────────────────────
  // Do NOT enable sendDefaultPii – it would attach cookies and auth headers.
  sendDefaultPii: false,

  beforeSend(event) {
    // Strip any accidentally included user info (wallet address, email, etc.)
    if (event.user) {
      // Keep only a stable, anonymous identifier if present; drop everything
      // else that could be considered PII.
      const { id } = event.user;
      event.user = id ? { id } : undefined;
    }
    return event;
  },
});
