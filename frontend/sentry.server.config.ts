/**
 * Sentry server-side (Node.js) SDK initialisation.
 *
 * Picked up automatically by @sentry/nextjs for all server components, API
 * route handlers, and server actions that run in the Node.js runtime.
 *
 * Required environment variable:
 *   NEXT_PUBLIC_SENTRY_DSN – Your Sentry project DSN.
 *                            SDK is disabled (no-ops) when this is absent.
 */

import * as Sentry from "@sentry/nextjs";
import { scrubStellarAddresses } from "./src/lib/sentry";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),

  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,

  tracesSampleRate: 0.1,

  sendDefaultPii: false,

  beforeSend(event) {
    if (event.user) {
      const { id } = event.user;
      if (id) {
        event.user = { id };
      } else {
        delete event.user;
      }
    }
    return scrubStellarAddresses(event);
  },
});
