"use client";

import { useEffect, useState } from "react";

interface MaintenanceStatus {
  active: boolean;
  currentLedgerSequence: number;
  window: {
    id: string;
    endLedgerSequence: number | null;
    reason: string;
  } | null;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const POLL_INTERVAL_MS = 30_000;

/**
 * Polls the public, unauthenticated maintenance status endpoint (#1399) and
 * shows a persistent banner while a maintenance window is active — mirrors
 * StellarSetupBanner's fixed-bottom pattern but is driven by live backend
 * state instead of a static config flag.
 */
export function MaintenanceBanner() {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${API_BASE}/api/maintenance/status`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as MaintenanceStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // A failed status check should not itself surface an error banner —
        // it just means we keep showing whatever we last knew (or nothing).
      }
    }

    void poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (!status?.active || !status.window) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-amber-500/40 bg-amber-950/95 px-4 py-3 text-center text-sm text-amber-100 backdrop-blur"
    >
      <span className="font-semibold uppercase tracking-wide">Maintenance in progress</span>
      {" — "}
      {status.window.reason}
      {status.window.endLedgerSequence !== null && (
        <> (expected to lift at ledger {status.window.endLedgerSequence})</>
      )}
      . New actions are temporarily disabled; browsing still works normally.
    </div>
  );
}
