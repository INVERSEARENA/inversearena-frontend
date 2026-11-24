"use client";

import React, { useState, useEffect } from "react";
import { useHostArenas, evaluateHostPreconditions, type HostArena } from "@/features/host/hooks/useHostArenas";
import { formatCountdown } from "@/shared-d/utils/formatters";

export function HostDashboard() {
  const { arenas, loading, page, setPage, address } = useHostArenas();
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [actionError, setActionError] = useState<string | null>(null);
  const [simulating, setSimulating] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleAction = async (arena: HostArena, action: string) => {
    setActionError(null);
    setSimulating(`${arena.id}-${action}`);
    try {
      // Simulate action first via backend simulation endpoint
      const simRes = await fetch(`/api/arenas/${arena.id}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, caller: address }),
      });
      if (!simRes.ok) {
        const err = await simRes.json().catch(() => ({ message: "Simulation failed" }));
        throw new Error(err.message || "Simulation reverted on-chain");
      }

      // If simulation passes, trigger execution
      const execRes = await fetch(`/api/arenas/${arena.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, caller: address }),
      });
      if (!execRes.ok) {
        const err = await execRes.json().catch(() => ({ message: "Execution failed" }));
        throw new Error(err.message || "Action failed");
      }
    } catch (e: any) {
      setActionError(e.message || "Action failed");
    } finally {
      setSimulating(null);
    }
  };

  if (!address) {
    return (
      <div className="p-6 text-center text-gray-500">
        Please connect your wallet to view your hosted arenas.
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Host Control Panel</h1>
        <span className="text-sm text-gray-500">Connected: {address}</span>
      </div>

      {actionError && (
        <div className="p-4 bg-red-100 border border-red-300 text-red-700 rounded-md">
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="text-center py-10">Loading hosted arenas...</div>
      ) : arenas.length === 0 ? (
        <div className="p-8 text-center bg-gray-50 dark:bg-gray-800 rounded-lg">
          <p className="text-gray-600 dark:text-gray-300">No arenas hosted by this wallet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {arenas.map((arena) => {
            const pre = evaluateHostPreconditions(arena, now);
            return (
              <div
                key={arena.id}
                className="p-5 bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 space-y-4"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{arena.name}</h2>
                    <p className="text-xs text-gray-500">ID: {arena.id}</p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      Phase: {arena.phase}
                    </span>
                    {arena.paused && (
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        PAUSED
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-gray-600 dark:text-gray-300">
                  <div>
                    <span className="font-medium">Players:</span> {arena.playerCount} / {arena.maxPlayers} (min: {arena.minPlayers})
                  </div>
                  <div>
                    <span className="font-medium">Round:</span> {arena.currentRound} / {arena.totalRounds}
                  </div>
                  <div>
                    <span className="font-medium">Commits:</span> {arena.commitProgress.committed} / {arena.commitProgress.total}
                  </div>
                  <div>
                    <span className="font-medium">Reveals:</span> {arena.revealProgress.revealed} / {arena.revealProgress.total}
                  </div>
                </div>

                {/* Live Preconditions Checklist */}
                <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                    On-Chain Preconditions & Actions
                  </h3>
                  <div className="flex flex-wrap gap-3">
                    {/* Start Round */}
                    <div className="flex flex-col items-start">
                      <button
                        disabled={!pre.start_round.allowed || simulating === `${arena.id}-start_round`}
                        onClick={() => handleAction(arena, "start_round")}
                        className={`px-3 py-1.5 rounded text-xs font-medium text-white ${
                          pre.start_round.allowed ? "bg-green-600 hover:bg-green-700" : "bg-gray-400 cursor-not-allowed"
                        }`}
                        title={pre.start_round.reasons.join(", ")}
                      >
                        {simulating === `${arena.id}-start_round` ? "Simulating..." : "Start Round"}
                      </button>
                      {!pre.start_round.allowed && (
                        <span className="text-[10px] text-red-500 mt-1 max-w-[150px]">
                          {pre.start_round.reasons[0]}
                        </span>
                      )}
                    </div>

                    {/* Resolve Round */}
                    <div className="flex flex-col items-start">
                      <button
                        disabled={!pre.resolve_round.allowed || simulating === `${arena.id}-resolve_round`}
                        onClick={() => handleAction(arena, "resolve_round")}
                        className={`px-3 py-1.5 rounded text-xs font-medium text-white ${
                          pre.resolve_round.allowed ? "bg-indigo-600 hover:bg-indigo-700" : "bg-gray-400 cursor-not-allowed"
                        }`}
                        title={pre.resolve_round.reasons.join(", ")}
                      >
                        {simulating === `${arena.id}-resolve_round` ? "Simulating..." : "Resolve Round"}
                      </button>
                      {!pre.resolve_round.allowed && (
                        <span className="text-[10px] text-red-500 mt-1 max-w-[150px]">
                          {pre.resolve_round.reasons[0]}
                        </span>
                      )}
                    </div>

                    {/* Pause / Unpause */}
                    <div className="flex flex-col items-start">
                      {arena.paused ? (
                        <button
                          disabled={!pre.unpause.allowed || simulating === `${arena.id}-unpause`}
                          onClick={() => handleAction(arena, "unpause")}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white"
                        >
                          Unpause
                        </button>
                      ) : (
                        <button
                          disabled={!pre.pause.allowed || simulating === `${arena.id}-pause`}
                          onClick={() => handleAction(arena, "pause")}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white"
                        >
                          Pause
                        </button>
                      )}
                    </div>

                    {/* Cancel Arena */}
                    <div className="flex flex-col items-start">
                      <button
                        disabled={!pre.cancel_arena.allowed || simulating === `${arena.id}-cancel_arena`}
                        onClick={() => handleAction(arena, "cancel_arena")}
                        className={`px-3 py-1.5 rounded text-xs font-medium text-white ${
                          pre.cancel_arena.allowed ? "bg-red-600 hover:bg-red-700" : "bg-gray-400 cursor-not-allowed"
                        }`}
                        title={pre.cancel_arena.reasons.join(", ")}
                      >
                        Cancel Arena
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      <div className="flex justify-between items-center pt-4">
        <button
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
          className="px-4 py-2 border rounded text-sm disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-sm">Page {page}</span>
        <button
          onClick={() => setPage(page + 1)}
          className="px-4 py-2 border rounded text-sm"
        >
          Next
        </button>
      </div>
    </div>
  );
}

export default HostDashboard;
