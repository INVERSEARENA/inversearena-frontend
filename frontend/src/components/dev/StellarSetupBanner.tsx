"use client";

import { isStellarConfigured, stellarConfigError } from "@/lib/stellarConfig";

/**
 * Issue #1134 — surfaces missing/invalid Stellar env vars as a visible,
 * dismissible-by-scrolling-past banner in development, instead of the
 * previous behavior of crashing the entire app at import time. Renders
 * nothing in production or once Stellar is properly configured.
 */
export function StellarSetupBanner() {
  if (process.env.NODE_ENV !== "development" || isStellarConfigured) {
    return null;
  }

  return (
    <div
      role="alert"
      className="fixed bottom-0 left-0 right-0 z-[999] border-t border-yellow-600 bg-yellow-950/95 px-4 py-3 font-mono text-xs text-yellow-200 backdrop-blur"
    >
      <p className="font-bold uppercase tracking-wider text-yellow-400">
        Stellar setup incomplete (dev only)
      </p>
      <p className="mt-1">{stellarConfigError}</p>
      <p className="mt-1 text-yellow-300/80">
        Pages not touching Stellar still work. Anything doing a Soroban
        operation will throw until these are set in .env.local.
      </p>
    </div>
  );
}
