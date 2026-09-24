"use client";

/**
 * ArenaHealthBadge (#1412)
 *
 * Displays a compact health status for an arena based on the composite
 * health summary returned by GET /api/arenas/:id/health.
 *
 * Signals shown:
 *  - overallStatus (HEALTHY / DEGRADED / CRITICAL)
 *  - chainLag (seconds since last on-chain confirmation)
 *  - queueLag (age of oldest queued payout)
 *  - stateDrift (time beyond expected round-state TTL)
 *
 * Accessibility: status changes are announced to screen readers via aria-live.
 */

import React, { useEffect, useState, useCallback } from "react";

// ── Types (mirror ArenaHealthSummary from backend) ────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "critical";

export interface HealthSignal {
  valueSeconds: number;
  status: HealthStatus;
  evidenceAt: string;
}

export interface ArenaHealthSummary {
  arenaId: string;
  overallStatus: HealthStatus;
  evaluatedAt: string;
  signals: {
    chainLag: HealthSignal;
    queueLag: HealthSignal;
    stateDrift: HealthSignal & { roundState: string };
  };
}

// ── Visual config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  HealthStatus,
  { label: string; colorClass: string; dotClass: string }
> = {
  healthy:  { label: "HEALTHY",  colorClass: "text-lime-400",   dotClass: "bg-lime-400" },
  degraded: { label: "DEGRADED", colorClass: "text-yellow-400", dotClass: "bg-yellow-400" },
  critical: { label: "CRITICAL", colorClass: "text-red-500",    dotClass: "bg-red-500 animate-pulse" },
};

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ArenaHealthBadgeProps {
  arenaId: string;
  /** Poll interval in milliseconds. Defaults to 15 000 ms. */
  pollIntervalMs?: number;
  /** If true, renders a compact single-line badge. Default: false. */
  compact?: boolean;
}

export function ArenaHealthBadge({
  arenaId,
  pollIntervalMs = 15_000,
  compact = false,
}: ArenaHealthBadgeProps) {
  const [health, setHealth] = useState<ArenaHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`/api/arenas/${arenaId}/health`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ArenaHealthSummary;
      setHealth(data);
      setError(null);
    } catch (err) {
      setError("Health check unavailable");
    } finally {
      setLoading(false);
    }
  }, [arenaId]);

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, pollIntervalMs);
    return () => clearInterval(id);
  }, [fetchHealth, pollIntervalMs]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="inline-block w-2 h-2 rounded-full bg-slate-500 animate-pulse" />
        <span>Checking health…</span>
      </div>
    );
  }

  if (error || !health) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-500"
        role="status"
        aria-label="Arena health unavailable"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />
        <span>{error ?? "Health unavailable"}</span>
      </div>
    );
  }

  const cfg = STATUS_CONFIG[health.overallStatus];

  if (compact) {
    return (
      <div
        className="flex items-center gap-1.5"
        role="status"
        aria-live="polite"
        aria-label={`Arena health: ${cfg.label}`}
      >
        <span className={`inline-block w-2 h-2 rounded-full ${cfg.dotClass}`} />
        <span className={`text-xs font-black tracking-widest ${cfg.colorClass}`}>
          {cfg.label}
        </span>
      </div>
    );
  }

  return (
    <div
      className="border border-white/10 bg-black/30 p-4 space-y-3"
      role="status"
      aria-live="polite"
      aria-label={`Arena health: ${cfg.label}`}
    >
      {/* Overall status */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
          Arena Health
        </span>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${cfg.dotClass}`} />
          <span className={`text-xs font-black tracking-widest ${cfg.colorClass}`}>
            ■ {cfg.label}
          </span>
        </div>
      </div>

      {/* Individual signals */}
      <div className="grid grid-cols-3 gap-3">
        <SignalCell
          label="Chain Lag"
          signal={health.signals.chainLag}
        />
        <SignalCell
          label="Queue Lag"
          signal={health.signals.queueLag}
        />
        <SignalCell
          label={`State Drift (${health.signals.stateDrift.roundState})`}
          signal={health.signals.stateDrift}
        />
      </div>

      {/* Evidence timestamp */}
      <p className="text-xs text-slate-600 text-right">
        Evaluated {new Date(health.evaluatedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}

// ── Signal cell ───────────────────────────────────────────────────────────────

function SignalCell({
  label,
  signal,
}: {
  label: string;
  signal: HealthSignal;
}) {
  const cfg = STATUS_CONFIG[signal.status];

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-slate-500 uppercase tracking-widest leading-tight">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.dotClass}`} />
        <span className={`text-sm font-black ${cfg.colorClass}`}>
          {formatSeconds(signal.valueSeconds)}
        </span>
      </div>
    </div>
  );
}
