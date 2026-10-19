"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/features/wallet/hooks/useWallet";
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
} from "lucide-react";

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
  const [arenas, setArenas] = useState<CreatorArenaSummary[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);

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
  }, [fetchCreatorArenas]);

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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
