/**
 * Host arena management client and hooks.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useWallet } from "@/features/wallet";

export type ArenaPhase = "lobby" | "committing" | "revealing" | "resolving" | "settled" | "cancelled";

export interface HostArena {
  id: string;
  name: string;
  hostAddress: string;
  phase: ArenaPhase;
  currentRound: number;
  totalRounds: number;
  minPlayers: number;
  maxPlayers: number;
  playerCount: number;
  commitProgress: { committed: number; total: number };
  revealProgress: { revealed: number; total: number };
  deadlines: {
    joinDeadline?: number;
    commitDeadline?: number;
    revealDeadline?: number;
    gracePeriodDeadline?: number;
  };
  paused: boolean;
  coHosts?: string[];
}

export interface ActionPrecondition {
  action: "start_round" | "resolve_round" | "pause" | "unpause" | "cancel_arena" | "ban_player";
  allowed: boolean;
  reasons: string[];
  countdownSeconds?: number;
}

export function evaluateHostPreconditions(arena: HostArena, nowSeconds: number): Record<string, ActionPrecondition> {
  const result: Record<string, ActionPrecondition> = {};

  // 1. start_round
  {
    const reasons: string[] = [];
    if (arena.paused) reasons.push("Arena is paused");
    if (arena.phase !== "lobby" && arena.phase !== "revealing" && arena.phase !== "resolving") {
      if (arena.phase === "committing") reasons.push("Current round is actively committing");
    }
    if (arena.phase === "lobby" && arena.playerCount < arena.minPlayers) {
      reasons.push(`Not enough players: minimum ${arena.minPlayers} required`);
    }
    let countdown: number | undefined;
    if (arena.deadlines.gracePeriodDeadline && arena.deadlines.gracePeriodDeadline > nowSeconds) {
      countdown = arena.deadlines.gracePeriodDeadline - nowSeconds;
      reasons.push(`Grace period not elapsed (${countdown}s remaining)`);
    }
    result.start_round = {
      action: "start_round",
      allowed: reasons.length === 0,
      reasons,
      countdownSeconds: countdown,
    };
  }

  // 2. resolve_round
  {
    const reasons: string[] = [];
    if (arena.paused) reasons.push("Arena is paused");
    if (arena.phase !== "revealing") {
      reasons.push("Arena is not in reveal phase");
    }
    if (arena.revealProgress.revealed < arena.revealProgress.total) {
      if (arena.deadlines.revealDeadline && arena.deadlines.revealDeadline > nowSeconds) {
        const countdown = arena.deadlines.revealDeadline - nowSeconds;
        reasons.push(`Reveal deadline has not passed (${countdown}s remaining)`);
      }
    }
    result.resolve_round = {
      action: "resolve_round",
      allowed: reasons.length === 0,
      reasons,
    };
  }

  // 3. pause / unpause
  {
    result.pause = {
      action: "pause",
      allowed: !arena.paused && arena.phase !== "settled" && arena.phase !== "cancelled",
      reasons: arena.paused ? ["Already paused"] : [],
    };
    result.unpause = {
      action: "unpause",
      allowed: arena.paused,
      reasons: !arena.paused ? ["Not paused"] : [],
    };
  }

  // 4. cancel_arena
  {
    const reasons: string[] = [];
    if (arena.phase === "settled") reasons.push("Arena already settled");
    if (arena.phase === "cancelled") reasons.push("Arena already cancelled");
    result.cancel_arena = {
      action: "cancel_arena",
      allowed: reasons.length === 0,
      reasons,
    };
  }

  // 5. ban_player
  {
    const reasons: string[] = [];
    if (arena.phase === "settled" || arena.phase === "cancelled") {
      reasons.push("Arena is closed");
    }
    result.ban_player = {
      action: "ban_player",
      allowed: reasons.length === 0,
      reasons,
    };
  }

  return result;
}

export function useHostArenas() {
  const { address } = useWallet();
  const [arenas, setArenas] = useState<HostArena[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    if (!address) {
      setArenas([]);
      return;
    }
    setLoading(true);
    fetch(`/api/arenas?host=${encodeURIComponent(address)}&page=${page}&limit=${pageSize}`)
      .then((res) => (res.ok ? res.json() : { arenas: [] }))
      .then((data) => {
        const items = (data.arenas || []).map((a: any) => ({
          id: a.id || a.contractId || a._id,
          name: a.name || `Arena ${a.id?.slice(0, 8)}`,
          hostAddress: a.hostAddress || a.createdBy || address,
          phase: a.phase || a.status || "lobby",
          currentRound: a.currentRound || 1,
          totalRounds: a.totalRounds || 3,
          minPlayers: a.minPlayers || 2,
          maxPlayers: a.maxPlayers || 10,
          playerCount: a.playerCount || a.participantsCount || 0,
          commitProgress: a.commitProgress || { committed: 0, total: a.playerCount || 0 },
          revealProgress: a.revealProgress || { revealed: 0, total: a.playerCount || 0 },
          deadlines: a.deadlines || {},
          paused: Boolean(a.paused),
          coHosts: a.coHosts || [],
        }));
        setArenas(items);
      })
      .catch(() => setArenas([]))
      .finally(() => setLoading(false));
  }, [address, page]);

  return { arenas, loading, page, setPage, address };
}
