"use client";

/**
 * PlayerRoster — pure presentational participant list for the lobby (#1604).
 *
 * Renders the live player feed table.  Receives all data as props; owns no
 * state and performs no fetching.  This isolation means a roster update
 * (new participant arriving via polling) does not re-render LobbyHeader or
 * JoinPanel.
 */

import type { ArenaParticipant } from "../hooks/useLobbyData";

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export interface PlayerRosterProps {
  participants: ArenaParticipant[];
  hasMore: boolean;
  loadingParticipants: boolean;
  nextCursor: number | null;
  onLoadMore: (cursor: number) => void;
}

export function PlayerRoster({
  participants,
  hasMore,
  loadingParticipants,
  nextCursor,
  onLoadMore,
}: PlayerRosterProps) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-[#08101b]/95 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6">
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">
            Live Player Feed
          </p>
          <h2 className="mt-1 text-2xl font-black uppercase tracking-tight">
            {participants.length} tracked participants
          </h2>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
            Polling
          </p>
          <p className="text-sm text-white/70">
            {loadingParticipants ? "Refreshing..." : "Every 5s while open"}
          </p>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-white/10">
        <div className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.7fr] bg-black/30 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
          <span>Wallet</span>
          <span>Choice</span>
          <span>Stake</span>
          <span>Status</span>
        </div>
        <div className="divide-y divide-white/10">
          {participants.length === 0 ? (
            <div className="px-4 py-8 text-sm text-white/55">
              No participant data has been recorded for this round yet.
            </div>
          ) : (
            participants.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.7fr] items-center px-4 py-4 text-sm"
              >
                <span className="font-mono text-white">
                  {shortAddress(p.walletAddress)}
                </span>
                <span
                  className={
                    p.choice === null
                      ? "font-semibold text-white/40"
                      : p.choice === "heads"
                        ? "font-semibold text-[#3CFF1A]"
                        : "font-semibold text-[#FF0A54]"
                  }
                >
                  {p.choice === null ? "HIDDEN" : p.choice.toUpperCase()}
                </span>
                <span className="font-mono text-white/80">
                  {p.stake.toLocaleString()}
                </span>
                <span
                  className={
                    p.status === "ELIMINATED"
                      ? "font-semibold text-[#FF0A54]"
                      : p.status === "READY"
                        ? "font-semibold text-[#3CFF1A]"
                        : "font-semibold text-white/70"
                  }
                >
                  {p.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
          {hasMore ? "More participants available" : "End of list"}
        </p>
        {hasMore && (
          <button
            type="button"
            onClick={() => onLoadMore(nextCursor ?? 0)}
            className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#3CFF1A] underline underline-offset-4"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
