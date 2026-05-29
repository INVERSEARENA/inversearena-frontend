"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArenaStatsSkeleton } from "@/components/arena/ArenaStatsSkeleton";
import { ChoiceSubmission } from "@/components/arena/ChoiceSubmission";
import { useStellarWallet } from "@/features/wallet/useStellarWallet";
import { stellarConfig } from "@/lib/stellarConfig";

interface ArenaStats {
  arenaId: string;
  arenaName: string;
  currentPot: number;
  playerCount: number;
  maxPlayers: number;
  survivorCount: number;
  currentRound: number;
  entryFee: number;
  stakeToken: string;
  joinDeadline: string | null;
  yieldAccrued: number;
  status: string;
  lastUpdated: string;
}

interface ArenaParticipant {
  id: string;
  walletAddress: string;
  choice: "heads" | "tails";
  stake: number;
  status: "READY" | "ACTIVE" | "ELIMINATED";
  roundNumber: number;
  joinedAt: string;
}

interface ArenaParticipantsResponse {
  arenaId: string;
  total: number;
  nextCursor: number | null;
  hasMore: boolean;
  items: ArenaParticipant[];
}

interface ArenaLobbyClientProps {
  arenaId: string;
  initialStats: ArenaStats | null;
  initialParticipants: ArenaParticipant[];
  initialNextCursor: number | null;
  notFound?: boolean;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

function formatCurrency(value: number, token: string): string {
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${token}`;
}

function formatCountdown(joinDeadline: string | null): string {
  if (!joinDeadline) return "Unknown";
  const remaining = Math.max(0, Date.parse(joinDeadline) - Date.now());
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ArenaLobbyClient({
  arenaId,
  initialStats,
  initialParticipants,
  initialNextCursor,
  notFound = false,
}: ArenaLobbyClientProps) {
  const router = useRouter();
  const wallet = useStellarWallet(stellarConfig.network);
  const [stats, setStats] = useState<ArenaStats | null>(initialStats);
  const [participants, setParticipants] = useState<ArenaParticipant[]>(
    initialParticipants,
  );
  const [nextCursor, setNextCursor] = useState<number | null>(initialNextCursor);
  const [hasMore, setHasMore] = useState(Boolean(initialNextCursor !== null));
  const [loadingStats, setLoadingStats] = useState(false);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOpen = stats?.status === "open";
  const walletConnected = wallet.isConnected && !!wallet.publicKey;

  const mergedParticipants = useMemo(() => {
    const map = new Map<string, ArenaParticipant>();
    for (const participant of participants) {
      map.set(participant.id, participant);
    }
    return Array.from(map.values());
  }, [participants]);

  const mergeParticipants = (incoming: ArenaParticipant[]) => {
    setParticipants((current) => {
      const map = new Map<string, ArenaParticipant>();
      for (const participant of incoming) {
        map.set(participant.id, participant);
      }
      for (const participant of current) {
        if (!map.has(participant.id)) {
          map.set(participant.id, participant);
        }
      }
      return Array.from(map.values());
    });
  };

  const fetchStats = async () => {
    setLoadingStats(true);
    try {
      const response = await fetch(`${API_BASE}/api/arenas/${arenaId}/stats`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Stats request failed (${response.status})`);
      }

      const data = (await response.json()) as ArenaStats;
      setStats(data);
      setError(null);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : "Failed to refresh arena stats",
      );
    } finally {
      setLoadingStats(false);
    }
  };

  const fetchParticipants = async (cursor = 0, replace = false) => {
    setLoadingParticipants(true);
    try {
      const params = new URLSearchParams({
        limit: "12",
        cursor: String(cursor),
      });
      const response = await fetch(
        `${API_BASE}/api/arenas/${arenaId}/participants?${params.toString()}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`Participants request failed (${response.status})`);
      }

      const data = (await response.json()) as ArenaParticipantsResponse;
      if (replace || cursor === 0) {
        mergeParticipants(data.items);
      } else {
        setParticipants((current) => [...current, ...data.items]);
      }
      setNextCursor(data.nextCursor);
      setHasMore(data.hasMore);
      setError(null);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to refresh participants",
      );
    } finally {
      setLoadingParticipants(false);
    }
  };

  useEffect(() => {
    setStats(initialStats);
    setParticipants(initialParticipants);
    setNextCursor(initialNextCursor);
    setHasMore(initialNextCursor !== null);
  }, [initialStats, initialParticipants, initialNextCursor]);

  useEffect(() => {
    if (notFound) return;

    void fetchStats();
    void fetchParticipants(0, true);

    const statsTimer = window.setInterval(() => {
      void fetchStats();
    }, 10_000);

    const participantsTimer = window.setInterval(() => {
      if (isOpen) {
        void fetchParticipants(0, true);
      }
    }, 5_000);

    return () => {
      window.clearInterval(statsTimer);
      window.clearInterval(participantsTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arenaId, notFound, isOpen]);

  if (notFound) {
    return (
      <div className="min-h-screen bg-[#050816] px-4 py-10 text-white sm:px-6 lg:px-8">
        <div className="mx-auto flex min-h-[70vh] w-full max-w-4xl flex-col justify-center rounded-[28px] border border-white/10 bg-[#08101b] p-8 text-center shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/45">
            Arena not found
          </p>
          <h1 className="mt-3 text-4xl font-black uppercase tracking-tight">
            No lobby exists for this ID
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-white/65">
            The arena identifier <span className="font-mono text-white">{arenaId}</span> does not resolve to an active lobby.
            You can return to the games dashboard and pick another arena.
          </p>
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={() => router.push("/dashboard/games")}
              className="rounded-full border border-white/10 bg-white px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-black transition hover:opacity-90"
            >
              Back to Games
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="min-h-screen bg-[#050816] px-4 py-10 text-white sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-7xl">
          <ArenaStatsSkeleton />
        </div>
      </div>
    );
  }

  const playerCapacity =
    stats.maxPlayers > 0 ? `${stats.playerCount}/${stats.maxPlayers}` : `${stats.playerCount}`;
  const joinDisabled = !isOpen || !stats.joinDeadline || loadingStats || !walletConnected;
  const joinLabel = !walletConnected
    ? "Wallet Required"
    : joinDisabled
      ? "Join Unavailable"
      : "Join Arena";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(60,255,26,0.14),_transparent_36%),linear-gradient(180deg,_#050816_0%,_#07111d_42%,_#050816_100%)] px-4 py-6 text-white sm:px-6 lg:px-8">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="rounded-[32px] border border-white/10 bg-[#08101b]/95 p-6 shadow-[0_30px_100px_rgba(0,0,0,0.4)] backdrop-blur sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#3CFF1A]/30 bg-[#07140b] px-3 py-1">
                <span className="h-2.5 w-2.5 rounded-full bg-[#3CFF1A] shadow-[0_0_18px_rgba(60,255,26,0.85)]" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#c8ffd1]">
                  {stats.status.toUpperCase()} / Round {stats.currentRound}
                </span>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/45">
                  Arena Lobby
                </p>
                <h1 className="mt-2 text-4xl font-black uppercase tracking-tight sm:text-5xl lg:text-6xl">
                  {stats.arenaName}
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-white/70 sm:text-base">
                  Live lobby for <span className="font-mono text-white">{arenaId}</span>. Track the player count, accumulated yield, and the countdown to the join deadline before you lock in your choice.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[560px]">
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Player Count
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">
                  {playerCapacity}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Current Pot
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">
                  {formatCurrency(stats.currentPot, stats.stakeToken)}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Accrued Yield
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums text-[#3CFF1A]">
                  +{formatCurrency(stats.yieldAccrued, stats.stakeToken)}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  Join Countdown
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">
                  {formatCountdown(stats.joinDeadline)}
                </p>
              </div>
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

            <button
              type="button"
              disabled={joinDisabled}
              onClick={() => {
                document.getElementById("choice-submission")?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                });
              }}
              className="rounded-full border border-[#3CFF1A]/40 bg-[#3CFF1A] px-6 py-3 text-sm font-black uppercase tracking-[0.2em] text-black transition hover:brightness-95 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-white/40"
            >
              {joinLabel}
            </button>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-[28px] border border-white/10 bg-[#08101b]/95 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">
                  Live Player Feed
                </p>
                <h2 className="mt-1 text-2xl font-black uppercase tracking-tight">
                  {mergedParticipants.length} tracked participants
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
                {mergedParticipants.length === 0 ? (
                  <div className="px-4 py-8 text-sm text-white/55">
                    No participant data has been recorded for this round yet.
                  </div>
                ) : (
                  mergedParticipants.map((participant) => (
                    <div
                      key={participant.id}
                      className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.7fr] items-center px-4 py-4 text-sm"
                    >
                      <span className="font-mono text-white">
                        {shortAddress(participant.walletAddress)}
                      </span>
                      <span
                        className={
                          participant.choice === "heads"
                            ? "font-semibold text-[#3CFF1A]"
                            : "font-semibold text-[#FF0A54]"
                        }
                      >
                        {participant.choice.toUpperCase()}
                      </span>
                      <span className="font-mono text-white/80">
                        {participant.stake.toLocaleString()}
                      </span>
                      <span
                        className={
                          participant.status === "ELIMINATED"
                            ? "font-semibold text-[#FF0A54]"
                            : participant.status === "READY"
                              ? "font-semibold text-[#3CFF1A]"
                              : "font-semibold text-white/70"
                        }
                      >
                        {participant.status}
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
                  onClick={() => void fetchParticipants(nextCursor ?? 0, false)}
                  className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#3CFF1A] underline underline-offset-4"
                >
                  Load more
                </button>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div id="choice-submission">
              <ChoiceSubmission
                arenaId={arenaId}
                roundNumber={stats.currentRound}
                deadline={stats.joinDeadline ?? ""}
                arenaStatus={stats.status}
                wallet={wallet}
              />
            </div>

            <div className="rounded-[28px] border border-white/10 bg-[#08101b]/95 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">
                Round Summary
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                    Survivors
                  </p>
                  <p className="mt-2 text-3xl font-black tabular-nums text-[#3CFF1A]">
                    {stats.survivorCount}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                    Entry Fee
                  </p>
                  <p className="mt-2 text-2xl font-black tabular-nums">
                    {formatCurrency(stats.entryFee, stats.stakeToken)}
                  </p>
                </div>
              </div>
              {error && (
                <p className="mt-4 rounded-2xl border border-[#FF0A54]/30 bg-[#16070d] px-4 py-3 text-sm text-[#FFB3C4]">
                  {error}
                </p>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
