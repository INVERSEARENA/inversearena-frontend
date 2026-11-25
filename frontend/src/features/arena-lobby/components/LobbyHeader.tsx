"use client";

/**
 * LobbyHeader — pure presentational header for an arena lobby (#1604).
 *
 * Renders the arena name, status badge, stat tiles, and join/leave actions.
 * Receives all data and callbacks as props; owns no state.
 */

import type { ArenaStats } from "../hooks/useLobbyData";
import { useLobbyCountdown } from "../hooks/useLobbyCountdown";

function formatCurrency(value: number, token: string): string {
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${token}`;
}

export interface LobbyHeaderProps {
  arenaId: string;
  stats: ArenaStats;
  walletConnected: boolean;
  isParticipant: boolean;
  canLeave: boolean;
  loadingStats: boolean;
  isReserving: boolean;
  reservationError: string | null;
  assetGatePhase: string;
  assetGateMessage: string;
  assetGateCanRetry: boolean;
  onJoinClick: () => void;
  onLeaveClick: () => void;
  onSetupTrustline: () => void;
  onRetryAssetCheck: () => void;
}

export function LobbyHeader({
  arenaId,
  stats,
  walletConnected,
  canLeave,
  loadingStats,
  isReserving,
  reservationError,
  assetGatePhase,
  assetGateMessage,
  assetGateCanRetry,
  onJoinClick,
  onLeaveClick,
  onSetupTrustline,
  onRetryAssetCheck,
}: LobbyHeaderProps) {
  const countdown = useLobbyCountdown(stats.joinDeadline);
  const isOpen = stats.status === "open";
  const hasPassedDeadline =
    stats.joinDeadline && Date.parse(stats.joinDeadline) <= Date.now();
  const joinDisabled =
    !isOpen || hasPassedDeadline || loadingStats || !walletConnected;
  const joinLabel = !walletConnected
    ? "Wallet Required"
    : joinDisabled
      ? "Join Unavailable"
      : "Join Arena";
  const playerCapacity =
    stats.maxPlayers > 0
      ? `${stats.playerCount}/${stats.maxPlayers}`
      : `${stats.playerCount}`;

  return (
    <section className="rounded-[32px] border border-white/10 bg-[#08101b]/95 p-6 shadow-[0_30px_100px_rgba(0,0,0,0.4)] backdrop-blur sm:p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#3CFF1A]/30 bg-[#07140b] px-3 py-1">
            <span className="h-2.5 w-2.5 rounded-full bg-[#3CFF1A] shadow-[0_0_18px_rgba(60,255,26,0.85)]" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#c8ffd1]">
              {stats.status.toUpperCase()} / Round {stats.currentRound}
            </span>
          </div>
          {stats.degraded && (
            <div
              role="status"
              className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-950/60 px-3 py-1"
            >
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-200">
                Delayed data
                {stats.ledgerSequence != null
                  ? ` — as of ledger ${stats.ledgerSequence}`
                  : ""}
              </span>
            </div>
          )}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/45">
              Arena Lobby
            </p>
            <h1 className="mt-2 text-4xl font-black uppercase tracking-tight sm:text-5xl lg:text-6xl">
              {stats.arenaName}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-white/70 sm:text-base">
              Live lobby for{" "}
              <span className="font-mono text-white">{arenaId}</span>.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[560px]">
          {[
            { label: "Player Count", value: playerCapacity },
            {
              label: "Current Pot",
              value: formatCurrency(stats.currentPot, stats.stakeToken),
            },
            {
              label: "Accrued Yield",
              value: `+${formatCurrency(stats.yieldAccrued, stats.stakeToken)}`,
              accent: true,
            },
            { label: "Join Countdown", value: countdown },
          ].map(({ label, value, accent }) => (
            <div
              key={label}
              className="rounded-2xl border border-white/10 bg-black/30 p-4"
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                {label}
              </p>
              <p
                className={`mt-2 text-2xl font-black tabular-nums${accent ? " text-[#3CFF1A]" : ""}`}
              >
                {value}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/40">
            Lobby state
          </p>
          <p className="text-sm text-white/70">
            {isOpen
              ? "Open for joins and active choice submission"
              : "Lobby is closed to new entries"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canLeave && (
            <button
              type="button"
              onClick={onLeaveClick}
              className="rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm font-black uppercase tracking-[0.2em] text-white/70 transition hover:border-red-400/50 hover:text-red-300"
            >
              Leave Arena
            </button>
          )}
          <button
            type="button"
            disabled={joinDisabled || isReserving}
            onClick={onJoinClick}
            className="rounded-full border border-[#3CFF1A]/40 bg-[#3CFF1A] px-6 py-3 text-sm font-black uppercase tracking-[0.2em] text-black transition hover:brightness-95 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-white/40"
          >
            {isReserving ? "Reserving..." : joinLabel}
          </button>
        </div>
      </div>

      {reservationError && (
        <p role="alert" className="mt-3 text-sm font-semibold text-red-400">
          {reservationError}
        </p>
      )}

      {assetGatePhase !== "ready" && assetGatePhase !== "idle" && (
        <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/70">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
            Asset readiness
          </p>
          <p className="mt-2 text-left">{assetGateMessage}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {assetGatePhase === "remediation_offered" && (
              <button
                type="button"
                onClick={onSetupTrustline}
                className="rounded-full border border-white/20 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-white"
              >
                Set up trustline
              </button>
            )}
            {assetGateCanRetry && (
              <button
                type="button"
                onClick={onRetryAssetCheck}
                className="rounded-full border border-white/20 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-white/70"
              >
                Check again
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
