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
import type { Event as SentryEvent } from "@sentry/nextjs";

// Matches any Stellar public key (G + 55 base32 chars) anywhere in a string.
const STELLAR_PUBLIC_KEY_REGEX = /G[A-Z2-7]{55}/g;
// Matches any Stellar secret key (S + 55 base32 chars). Events containing
// these are dropped entirely — they should never appear in error reports.
const STELLAR_SECRET_KEY_REGEX = /S[A-Z2-7]{55}/g;

/**
 * Replace all Stellar public keys in `text` with the placeholder
 * `[STELLAR_ADDRESS]`. Returns the original value if it is not a string.
 */
function redactPublicKeys(text: string): string {
  return text.replace(STELLAR_PUBLIC_KEY_REGEX, "[STELLAR_ADDRESS]");
}

/**
 * Scrub Stellar wallet addresses from a Sentry event before it is sent.
 *
 * - Public keys (G…) are replaced with `[STELLAR_ADDRESS]` in exception
 *   values, breadcrumb messages, and breadcrumb URLs.
 * - If a secret key (S…) appears anywhere in the serialised event the entire
 *   event is dropped (returns `null`) as a belt-and-suspenders safeguard.
 */
export function scrubStellarAddresses(event: SentryEvent): SentryEvent | null {
  // Belt-and-suspenders: drop the event entirely if a secret key leaks.
  if (STELLAR_SECRET_KEY_REGEX.test(JSON.stringify(event))) {
    return null;
  }

  // Scrub exception values (error messages / descriptions).
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) {
        ex.value = redactPublicKeys(ex.value);
      }
    }
  }

  // Scrub breadcrumb messages and navigation URLs.
  if (event.breadcrumbs?.values) {
    for (const breadcrumb of event.breadcrumbs.values) {
      if (breadcrumb.message) {
        breadcrumb.message = redactPublicKeys(breadcrumb.message);
      }
      if (breadcrumb.data?.url && typeof breadcrumb.data.url === "string") {
        breadcrumb.data.url = redactPublicKeys(breadcrumb.data.url);
      }
    }
  }

  return event;
}

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
