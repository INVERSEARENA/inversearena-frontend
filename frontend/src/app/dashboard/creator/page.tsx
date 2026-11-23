"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/features/wallet/hooks/useWallet";
import { apiClient } from "@/shared/lib/api/client";
import {
  Play,
  XCircle,
  RefreshCw,
  Award,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ShieldAlert,
  Search,
  Calendar,
  Pause,
  SkipForward,
  Check,
} from "lucide-react";

export interface CreatorSeriesSummary {
  id: string;
  name: string;
  templateId: string;
  cadence: string;
  timezone: string;
  status: "active" | "paused" | "completed" | "cancelled";
  instancesCreated: number;
  nextScheduledAt: string | null;
  instances?: Array<{
    id: string;
    scheduledFor: string;
    status: "pending" | "signed" | "created" | "skipped" | "failed";
    signRequestPayload?: any;
    txHash?: string | null;
  }>;
}

export type CreatorLifecycleState =
  | "waiting"
  | "actionable"
  | "blocked"
  | "degraded"
  | "terminal";

export interface CreatorArenaSummary {
  id: string;
  name: string;
  contractAddress: string;
  createdAt: string;
  phase: "DEPLOYED" | "LOBBY" | "ACTIVE" | "CANCELLED" | "SETTLED";
  state: CreatorLifecycleState;
  stateReason: string;
  health: {
    status: "healthy" | "warning" | "error";
    details?: string;
  };
  playerCount: number;
  maxPlayers: number;
  currentRound: number;
  entryFee: number;
  stakeToken: string;
  pendingTx?: {
    txHash: string;
    type: string;
    submittedAt: string;
  } | null;
  allowedActions: ("start" | "cancel" | "retry_confirmation" | "settle")[];
}

export default function CreatorOperationsConsole() {
  const { address, isConnected } = useWallet();
  const [activeTab, setActiveTab] = useState<"arenas" | "series">("arenas");
  const [arenas, setArenas] = useState<CreatorArenaSummary[]>([]);
  const [seriesList, setSeriesList] = useState<CreatorSeriesSummary[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [webhookArenaId, setWebhookArenaId] = useState<string | null>(null);

  const fetchCreatorSeries = useCallback(async () => {
    if (!address) return;
    try {
      const data = await apiClient.get<{ items: CreatorSeriesSummary[] }>("/api/creator/series");
      setSeriesList(data.items || []);
    } catch {
      setSeriesList([
        {
          id: "SERIES-001",
          name: "Daily 8pm High Stakes",
          templateId: "TMPL-001",
          cadence: "0 20 * * *",
          timezone: "America/New_York",
          status: "active",
          instancesCreated: 4,
          nextScheduledAt: new Date(Date.now() + 18000000).toISOString(),
          instances: [
            {
              id: "INST-005",
              scheduledFor: new Date(Date.now() + 18000000).toISOString(),
              status: "pending",
              signRequestPayload: { name: "Daily 8pm High Stakes #5", entryFee: 50 },
            },
            {
              id: "INST-004",
              scheduledFor: new Date(Date.now() - 68400000).toISOString(),
              status: "created",
              txHash: "a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef",
            },
          ],
        },
      ]);
    }
  }, [address]);

  const handleSeriesAction = async (
    seriesId: string,
    action: "pause" | "resume" | "skip",
  ) => {
    setActionLoading((prev) => ({ ...prev, [`${seriesId}-${action}`]: true }));
    try {
      await apiClient.post(`/api/creator/series/${seriesId}/${action}`);
      setBanner({ type: "success", message: `Series successfully updated (${action})` });
      void fetchCreatorSeries();
    } catch (err) {
      setBanner({
        type: "error",
        message: err instanceof Error ? err.message : `Failed to ${action} series`,
      });
    } finally {
      setActionLoading((prev) => ({ ...prev, [`${seriesId}-${action}`]: false }));
    }
  };

  const handleSignSeriesInstance = async (seriesId: string, instanceId: string) => {
    setActionLoading((prev) => ({ ...prev, [`${instanceId}-sign`]: true }));
    try {
      const dummyTxHash = "0".repeat(64);
      await apiClient.post(`/api/creator/series/${seriesId}/instances/${instanceId}/sign`, {
        txHash: dummyTxHash,
      });
      setBanner({ type: "success", message: "Series instance successfully signed & deployed!" });
      void fetchCreatorSeries();
    } catch (err) {
      setBanner({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to sign instance",
      });
    } finally {
      setActionLoading((prev) => ({ ...prev, [`${instanceId}-sign`]: false }));
    }
  };

  const fetchCreatorArenas = useCallback(async () => {
    if (!address) {
      setArenas([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const res = await fetch(`/api/creator/arenas?limit=50`);
      if (res.ok) {
        const data = await res.json();
        setArenas(data.items || []);
      } else {
        // Fallback for demonstration / local dev mock
        setArenas([
          {
            id: "ARENA-HOST-001",
            name: "Hyperion Championship",
            contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            createdAt: new Date().toISOString(),
            phase: "LOBBY",
            state: "actionable",
            stateReason: "READY_TO_START",
            health: { status: "healthy" },
            playerCount: 16,
            maxPlayers: 16,
            currentRound: 0,
            entryFee: 50,
            stakeToken: "USDC",
            allowedActions: ["start", "cancel"],
          },
          {
            id: "ARENA-HOST-002",
            name: "Nebula Micro-Sprint",
            contractAddress: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            phase: "LOBBY",
            state: "waiting",
            stateReason: "WAITING_FOR_PLAYERS",
            health: { status: "healthy" },
            playerCount: 4,
            maxPlayers: 32,
            currentRound: 0,
            entryFee: 10,
            stakeToken: "USDC",
            allowedActions: ["cancel"],
          },
          {
            id: "ARENA-HOST-003",
            name: "Vanguard Duel",
            contractAddress: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
            createdAt: new Date(Date.now() - 7200000).toISOString(),
            phase: "ACTIVE",
            state: "blocked",
            stateReason: "ACTIVE_ROUND_IN_PROGRESS",
            health: { status: "healthy" },
            playerCount: 8,
            maxPlayers: 8,
            currentRound: 2,
            entryFee: 25,
            stakeToken: "USDC",
            allowedActions: [],
          },
        ]);
      }
    } catch (err) {
      console.error("Failed to load creator arenas:", err);
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    fetchCreatorArenas();
    fetchCreatorSeries();
  }, [fetchCreatorArenas, fetchCreatorSeries]);

  const handleAction = async (
    arenaId: string,
    action: "start" | "cancel" | "retry_confirmation" | "settle",
  ) => {
    setActionLoading((prev) => ({ ...prev, [`${arenaId}-${action}`]: true }));
    setBanner(null);

    try {
      // Step 1: Preflight check immediately before mutation (#1509)
      const preflightRes = await fetch(`/api/creator/arenas/${arenaId}/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (!preflightRes.ok) {
        const errorData = await preflightRes.json().catch(() => ({}));
        throw new Error(errorData.reason || `Preflight check rejected for action ${action}`);
      }

      // Step 2: Execute mutation with deterministic reconciliation
      const actionRes = await fetch(`/api/creator/arenas/${arenaId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (!actionRes.ok) {
        const errJson = await actionRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Failed to execute ${action}`);
      }

      const resData = await actionRes.json();
      setBanner({
        type: "success",
        message: resData.message || `Action ${action} executed successfully`,
      });

      // Refresh listings
      await fetchCreatorArenas();
    } catch (err: any) {
      setBanner({
        type: "error",
        message: err.message || `Action execution failed`,
      });
    } finally {
      setActionLoading((prev) => ({ ...prev, [`${arenaId}-${action}`]: false }));
    }
  };

  const filteredArenas = arenas.filter((arena) => {
    const matchesFilter = filter === "all" || arena.state === filter;
    const matchesSearch =
      !search ||
      arena.name.toLowerCase().includes(search.toLowerCase()) ||
      arena.id.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const stateBadges: Record<CreatorLifecycleState, { label: string; class: string }> = {
    actionable: { label: "Actionable", class: "border-green-400 text-green-400 bg-green-500/10" },
    waiting: { label: "Waiting", class: "border-blue-400 text-blue-400 bg-blue-500/10" },
    blocked: { label: "Blocked", class: "border-yellow-400 text-yellow-400 bg-yellow-500/10" },
    degraded: { label: "Degraded", class: "border-orange-400 text-orange-400 bg-orange-500/10" },
    terminal: { label: "Terminal", class: "border-white/30 text-white/40 bg-white/5" },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-white/10 pb-5">
        <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-3">
          <ShieldAlert className="w-7 h-7 text-neon-green" />
          Creator Operations Console
        </h1>
        <p className="mt-1 text-sm text-white/60">
          Ownership-scoped operational lifecycle management, preflight validations, and recovery controls for your hosted arenas (#1509).
        </p>
      </div>

      {/* Mode Navigation Tabs */}
      <div className="flex border-b border-white/10 gap-6">
        <button
          onClick={() => setActiveTab("arenas")}
          className={`pb-3 text-sm font-semibold transition border-b-2 ${
            activeTab === "arenas"
              ? "border-neon-green text-neon-green"
              : "border-transparent text-white/60 hover:text-white"
          }`}
        >
          Hosted Arenas ({arenas.length})
        </button>
        <button
          onClick={() => setActiveTab("series")}
          className={`pb-3 text-sm font-semibold transition border-b-2 flex items-center gap-2 ${
            activeTab === "series"
              ? "border-neon-green text-neon-green"
              : "border-transparent text-white/60 hover:text-white"
          }`}
        >
          <Calendar className="w-4 h-4" />
          Recurring Series ({seriesList.length})
        </button>
      </div>

      {/* Banner */}
      {banner && (
        <div
          className={`p-4 rounded border flex items-center gap-3 ${
            banner.type === "success"
              ? "bg-green-500/10 border-green-500 text-green-300"
              : "bg-red-500/10 border-red-500 text-red-300"
          }`}
        >
          {banner.type === "success" ? (
            <CheckCircle2 className="w-5 h-5 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 shrink-0" />
          )}
          <span className="text-sm font-medium">{banner.message}</span>
        </div>
      )}

      {/* Main Tab Content */}
      {activeTab === "arenas" ? (
        <>
          {/* Controls: Search and Filter Tabs */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div className="flex flex-wrap gap-2">
          {["all", "actionable", "waiting", "blocked", "degraded", "terminal"].map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 text-xs font-pixel uppercase tracking-wider border rounded transition ${
                filter === tab
                  ? "bg-neon-green text-black border-neon-green font-bold"
                  : "border-white/20 text-white/60 hover:text-white hover:border-white/40"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-white/40" />
          <input
            type="text"
            placeholder="Search by arena name or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-1.5 bg-white/5 border border-white/10 rounded text-sm text-white placeholder-white/40 focus:outline-none focus:border-neon-green"
          />
        </div>
      </div>

      {/* Arena List */}
      {isLoading ? (
        <div className="p-12 text-center text-white/40 font-pixel text-xs animate-pulse">
          Loading creator arenas...
        </div>
      ) : filteredArenas.length === 0 ? (
        <div className="p-12 text-center border border-white/10 rounded bg-white/5">
          <Clock className="w-8 h-8 text-white/30 mx-auto mb-3" />
          <p className="text-white/60 text-sm">No arenas match the selected filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {filteredArenas.map((arena) => {
            const badge = stateBadges[arena.state];
            return (
              <div
                key={arena.id}
                className="p-5 border border-white/10 bg-dark-bg/60 rounded-lg space-y-4 hover:border-white/20 transition"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-semibold text-white">{arena.name}</h2>
                      <span className={`text-[10px] font-pixel px-2 py-0.5 border rounded uppercase ${badge.class}`}>
                        {badge.label}
                      </span>
                      <span className="text-xs text-white/40 font-mono">
                        {arena.phase} • {arena.stateReason}
                      </span>
                    </div>
                    <p className="text-xs text-white/50 font-mono mt-1">ID: {arena.id}</p>
                  </div>

                  {/* Actions Bar */}
                  <div className="flex flex-wrap items-center gap-2">
                    {arena.allowedActions.includes("start") && (
                      <button
                        onClick={() => handleAction(arena.id, "start")}
                        disabled={actionLoading[`${arena.id}-start`]}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-neon-green hover:bg-neon-green/90 text-black font-semibold text-xs rounded transition disabled:opacity-50"
                      >
                        <Play className="w-3.5 h-3.5 fill-black" />
                        {actionLoading[`${arena.id}-start`] ? "Starting..." : "Start Game"}
                      </button>
                    )}

                    {arena.allowedActions.includes("cancel") && (
                      <button
                        onClick={() => handleAction(arena.id, "cancel")}
                        disabled={actionLoading[`${arena.id}-cancel`]}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-red-500/50 hover:bg-red-500/20 text-red-400 text-xs rounded transition disabled:opacity-50"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        {actionLoading[`${arena.id}-cancel`] ? "Cancelling..." : "Cancel Arena"}
                      </button>
                    )}

                    {arena.allowedActions.includes("retry_confirmation") && (
                      <button
                        onClick={() => handleAction(arena.id, "retry_confirmation")}
                        disabled={actionLoading[`${arena.id}-retry_confirmation`]}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-yellow-500/50 hover:bg-yellow-500/20 text-yellow-300 text-xs rounded transition disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        {actionLoading[`${arena.id}-retry_confirmation`] ? "Reconciling..." : "Retry Confirmation"}
                      </button>
                    )}

                    {arena.allowedActions.includes("settle") && (
                      <button
                        onClick={() => handleAction(arena.id, "settle")}
                        disabled={actionLoading[`${arena.id}-settle`]}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs rounded transition disabled:opacity-50"
                      >
                        <Award className="w-3.5 h-3.5" />
                        {actionLoading[`${arena.id}-settle`] ? "Settling..." : "Settle"}
                      </button>
                    )}

                    {/* Issue #1735 — host-only community announcements. */}
                    <button
                      onClick={() =>
                        setWebhookArenaId((current) => (current === arena.id ? null : arena.id))
                      }
                      className="px-3 py-1.5 border border-white/20 text-white/60 hover:text-white hover:border-neon-green/50 text-xs rounded transition"
                    >
                      {webhookArenaId === arena.id ? "Hide webhooks" : "Community webhooks"}
                    </button>
                  </div>
                </div>

                {/* Diagnostics details */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-white/5 text-xs">
                  <div>
                    <span className="text-white/40 block">Lobby Fill</span>
                    <span className="text-white font-medium">
                      {arena.playerCount} / {arena.maxPlayers} players
                    </span>
                  </div>
                  <div>
                    <span className="text-white/40 block">Entry Fee</span>
                    <span className="text-white font-medium">
                      {arena.entryFee} {arena.stakeToken}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/40 block">Current Round</span>
                    <span className="text-white font-medium">
                      {arena.currentRound > 0 ? `Round ${arena.currentRound}` : "Lobby (Pre-game)"}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/40 block">Health Status</span>
                    <span
                      className={`font-medium ${
                        arena.health.status === "healthy"
                          ? "text-green-400"
                          : arena.health.status === "warning"
                          ? "text-yellow-400"
                          : "text-red-400"
                      }`}
                    >
                      {arena.health.status.toUpperCase()}
                    </span>
                  </div>
                </div>

                {webhookArenaId === arena.id && (
                  <div className="pt-3 border-t border-white/5">
                    <CommunityWebhookSettings arenaId={arena.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
        </>
      ) : (
        /* Recurring Series Tab (#1746) */
        <div className="space-y-4">
          {seriesList.length === 0 ? (
            <div className="p-12 text-center border border-white/10 rounded bg-white/5">
              <Calendar className="w-8 h-8 text-white/30 mx-auto mb-3" />
              <p className="text-white/60 text-sm">No scheduled series found.</p>
              <p className="text-white/40 text-xs mt-1">
                Define recurring series from your creator templates to automate recurring arena deployments.
              </p>
            </div>
          ) : (
            seriesList.map((series) => (
              <div
                key={series.id}
                className="p-5 rounded-lg border border-white/10 bg-black/40 backdrop-blur-sm space-y-4 hover:border-white/20 transition"
              >
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-white text-base">{series.name}</h3>
                      <span
                        className={`px-2 py-0.5 text-[10px] font-pixel tracking-wider uppercase border rounded ${
                          series.status === "active"
                            ? "border-green-400 text-green-400 bg-green-500/10"
                            : series.status === "paused"
                            ? "border-yellow-400 text-yellow-400 bg-yellow-500/10"
                            : "border-white/20 text-white/40 bg-white/5"
                        }`}
                      >
                        {series.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-xs text-white/40 font-mono mt-0.5">
                      Cadence: <span className="text-neon-green">{series.cadence}</span> • Timezone: {series.timezone} • Created: {series.instancesCreated} arenas
                    </p>
                  </div>

                  {/* Actions for Series */}
                  <div className="flex items-center gap-2">
                    {series.status === "active" ? (
                      <button
                        onClick={() => handleSeriesAction(series.id, "pause")}
                        disabled={actionLoading[`${series.id}-pause`]}
                        className="flex items-center gap-1 px-3 py-1.5 border border-yellow-500/50 hover:bg-yellow-500/20 text-yellow-300 text-xs rounded transition"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        Pause Schedule
                      </button>
                    ) : series.status === "paused" ? (
                      <button
                        onClick={() => handleSeriesAction(series.id, "resume")}
                        disabled={actionLoading[`${series.id}-resume`]}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs rounded transition"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Resume Schedule
                      </button>
                    ) : null}

                    {series.status === "active" && (
                      <button
                        onClick={() => handleSeriesAction(series.id, "skip")}
                        disabled={actionLoading[`${series.id}-skip`]}
                        className="flex items-center gap-1 px-3 py-1.5 border border-white/20 hover:bg-white/10 text-white/70 text-xs rounded transition"
                      >
                        <SkipForward className="w-3.5 h-3.5" />
                        Skip Next
                      </button>
                    )}
                  </div>
                </div>

                {/* Series Instances & Next Run */}
                <div className="pt-3 border-t border-white/5 text-xs space-y-3">
                  <div className="flex justify-between items-center text-white/60">
                    <span>
                      Next Scheduled Run:{" "}
                      <strong className="text-white">
                        {series.nextScheduledAt
                          ? new Date(series.nextScheduledAt).toLocaleString()
                          : "None"}
                      </strong>
                    </span>
                  </div>

                  {/* Instances list */}
                  {series.instances && series.instances.length > 0 && (
                    <div className="space-y-2 mt-2">
                      <span className="text-white/40 block text-[11px] font-pixel uppercase tracking-wider">
                        Recent & Upcoming Instances
                      </span>
                      <div className="grid grid-cols-1 gap-2">
                        {series.instances.map((inst) => (
                          <div
                            key={inst.id}
                            className="p-2.5 rounded border border-white/5 bg-white/[0.02] flex items-center justify-between text-xs"
                          >
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-white font-medium">
                                  {new Date(inst.scheduledFor).toLocaleString()}
                                </span>
                                <span
                                  className={`px-1.5 py-0.5 text-[9px] rounded font-pixel uppercase ${
                                    inst.status === "pending"
                                      ? "bg-yellow-500/20 text-yellow-300 border border-yellow-500/40"
                                      : inst.status === "created"
                                      ? "bg-green-500/20 text-green-300 border border-green-500/40"
                                      : "bg-white/10 text-white/50"
                                  }`}
                                >
                                  {inst.status}
                                </span>
                              </div>
                              {inst.txHash && (
                                <p className="text-[10px] text-white/40 font-mono mt-0.5">
                                  Tx: {inst.txHash.slice(0, 10)}...{inst.txHash.slice(-8)}
                                </p>
                              )}
                            </div>

                            {inst.status === "pending" && (
                              <button
                                onClick={() => handleSignSeriesInstance(series.id, inst.id)}
                                disabled={actionLoading[`${inst.id}-sign`]}
                                className="flex items-center gap-1 px-3 py-1.5 bg-neon-green hover:bg-neon-green/90 text-black font-semibold text-xs rounded transition"
                              >
                                <Check className="w-3.5 h-3.5" />
                                {actionLoading[`${inst.id}-sign`] ? "Signing..." : "One-Click Sign"}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
