/**
 * Sentry error reporting utility for the frontend.
 *
 * Initialisation happens in sentry.client.config.ts (loaded automatically by
 * the @sentry/nextjs SDK via next.config.ts).  This module exposes thin
 * helpers that the rest of the app (e.g. ErrorBoundary) can call without
 * importing Sentry directly, making it easy to swap the provider later.
 *
 * Privacy / PII: Sentry is configured with `sendDefaultPii: false` and a
 * `beforeSend` scrubber in sentry.client.config.ts.  Do NOT add user wallet
 * addresses, private keys, or any personal data to the extra context here.
 */

import * as Sentry from "@sentry/nextjs";
import type { ErrorInfo } from "react";

const SENTRY_ENABLED =
  typeof process !== "undefined" &&
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

/**
 * Report a React render error caught by an ErrorBoundary.
 *
 * @param error      - The thrown Error object.
 * @param errorInfo  - React's ErrorInfo (contains componentStack).
 * @param extra      - Optional additional key/value pairs (no PII).
 */
export function captureReactError(
  error: Error,
  errorInfo: ErrorInfo,
  extra?: Record<string, unknown>
): void {
  if (!SENTRY_ENABLED) return;

  Sentry.withScope((scope) => {
    // Attach the React component stack as extra context, not as a tag, so it
    // appears in the "Additional Data" section of the Sentry issue.
    scope.setExtra("componentStack", errorInfo.componentStack ?? "unavailable");

    if (extra) {
      Object.entries(extra).forEach(([key, value]) => {
        scope.setExtra(key, value);
      });
    }

    // Tag the issue so it's easy to filter in the Sentry dashboard.
    scope.setTag("error.source", "ErrorBoundary");

    Sentry.captureException(error);
  });
}
