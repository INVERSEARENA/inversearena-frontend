"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";

// Mock Data
const MOCK_ARENAS = [
  { id: "AR_8821", name: "Cyber Siege", stake: "500 XLM", participants: "12/20", status: "LIVE" },
  { id: "AR_7712", name: "Neon Nexus", stake: "1,200 XLM", participants: "8/15", status: "SETTLING" },
  { id: "AR_6654", name: "Gravity Void", stake: "250 XLM", participants: "20/20", status: "COMPLETED" },
  { id: "AR_5521", name: "Data Breach", stake: "1,000 XLM", participants: "5/10", status: "LIVE" },
];

const MOCK_HISTORY = [
  { arena: "#2042", stake: "500 XLM", rounds: "12 Rounds", result: "SURVIVED", pnl: "+88.0 XLM", success: true },
  { arena: "#2038", stake: "200 XLM", rounds: "5 Rounds", result: "ELIMINATED", pnl: "-200.0 XLM", success: false },
  { arena: "#2035", stake: "1,000 XLM", rounds: "15 Rounds", result: "SURVIVED", pnl: "+142.5 XLM", success: true },
  { arena: "#2030", stake: "750 XLM", rounds: "8 Rounds", result: "SURVIVED", pnl: "+65.0 XLM", success: true },
];

export default function ProfilePage() {
  const [arenaFilter, setArenaFilter] = useState<"All" | "Live">("All");

  const filteredArenas = arenaFilter === "All" 
    ? MOCK_ARENAS 
    : MOCK_ARENAS.filter(a => a.status === "LIVE");

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Agent Header Card */}
      <section className="relative overflow-hidden border-[1.5px] border-neon-green/30 bg-black/40 backdrop-blur-sm p-6 md:p-8">
        <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
          <div className="text-[120px] font-bold leading-none select-none -mr-8 -mt-8 font-mono">ID</div>
        </div>
        
        <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-8">
          {/* Avatar Tile */}
          <div className="w-24 h-24 md:w-32 md:h-32 bg-neon-green flex items-center justify-center shrink-0">
            <svg className="w-12 h-12 md:w-16 md:h-16 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>

          <div className="flex-1 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl md:text-3xl font-extralight tracking-tighter family-mono uppercase">
                AGENT_ID: <span className="text-neon-green">X_K42_99LR</span>
              </h2>
              <button 
                className="p-1.5 rounded-full hover:bg-white/10 text-zinc-400 transition-colors"
                onClick={() => navigator.clipboard.writeText("X_K42_99LR")}
                title="Copy ID"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>

            <div className="flex flex-wrap gap-4 items-center">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold font-mono">TOTAL SURVIVAL TIME:</span>
                <span className="text-sm font-mono text-white">482H 12M 04S</span>
              </div>
              <div className="flex gap-2">
                <span className="px-2 py-0.5 bg-neon-green/10 border border-neon-green/50 text-neon-green text-[10px] font-bold uppercase tracking-wider">RANK: VETERAN</span>
                <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-bold uppercase tracking-wider">LEVEL 42</span>
              </div>
            </div>
          </div>

          <Button variant="secondary" className="w-full md:w-auto mt-4 md:mt-0 border-neon-green/50 text-neon-green hover:bg-neon-green/10">
            EDIT PROFILE
          </Button>
        </div>
      </section>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Active Stake */}
        <div className="p-6 border border-white/5 bg-black/20 backdrop-blur-sm space-y-6">
          <div className="flex justify-between items-start">
            <h4 className="text-[10px] font-bold tracking-[0.2em] text-zinc-500 uppercase">ACTIVE_STAKE.SYS</h4>
            <div className="w-2 h-2 rounded-full bg-neon-green animate-pulse" />
          </div>
          <div>
            <div className="text-3xl font-extralight text-white font-mono tracking-tighter">15,000.00 XLM</div>
            <div className="text-[10px] text-neon-green font-mono uppercase tracking-widest mt-1">+12.5% APY ESTIMATED</div>
          </div>
          <Button variant="secondary" className="w-full h-10 text-[10px] tracking-widest uppercase border-white/10 hover:bg-white/5">
            MANAGE STAKE
          </Button>
        </div>

        {/* Total Yield Earned - Highlighted */}
        <div className="p-6 border-[1.5px] border-neon-pink bg-black/40 backdrop-blur-sm space-y-6 relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-neon-pink/10 blur-2xl group-hover:bg-neon-pink/20 transition-all" />
          <div className="flex justify-between items-start">
            <h4 className="text-[10px] font-bold tracking-[0.2em] text-neon-pink uppercase">YIELD_TOTAL_EARNED</h4>
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] font-bold text-neon-pink tracking-[0.1em] uppercase">LIVE TICKING</span>
              <div className="w-1.5 h-1.5 rounded-full bg-neon-pink animate-ping" />
            </div>
          </div>
          <div>
            <div className="text-3xl font-extralight text-white font-mono tracking-tighter">1,242.88 XLM</div>
            <div className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mt-1">GENERATED VIA RWA DEPLOYMENT</div>
          </div>
          <Button className="w-full h-10 text-[10px] tracking-widest uppercase bg-neon-pink hover:bg-neon-pink/90 text-white border-none">
            CLAIM YIELD
          </Button>
        </div>

        {/* Arenas Created */}
        <div className="p-6 border border-white/5 bg-black/20 backdrop-blur-sm space-y-6">
          <div className="flex justify-between items-start">
            <h4 className="text-[10px] font-bold tracking-[0.2em] text-zinc-500 uppercase">ARENAS_HOSTED.DATA</h4>
          </div>
          <div>
            <div className="text-3xl font-extralight text-white font-mono tracking-tighter">12</div>
            <div className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mt-1">TOTAL HOSTED MATCHES</div>
          </div>
          <Button variant="secondary" className="w-full h-10 text-[10px] tracking-widest uppercase border-white/10 hover:bg-white/5">
            HOST NEW ARENA
          </Button>
        </div>
      </div>

      {/* Bottom Content - 2 Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* My Arenas Table */}
        <div className="border border-white/5 bg-black/20 p-6 flex flex-col">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">MY_ARENAS.DAT</h3>
            <div className="flex bg-black/40 border border-white/10 p-1">
              {["All", "Live"].map((filter) => (
                <button
                  key={filter}
                  onClick={() => setArenaFilter(filter as any)}
                  className={`px-4 py-1 text-[10px] uppercase tracking-widest font-bold transition-all ${
                    arenaFilter === filter ? "bg-neon-green text-black" : "text-zinc-500 hover:text-white"
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[11px] uppercase tracking-wider">
              <thead>
                <tr className="text-zinc-500 border-b border-white/5">
                  <th className="pb-4 font-bold">ARENA / ID</th>
                  <th className="pb-4 font-bold">STAKE</th>
                  <th className="pb-4 font-bold text-center">PARTICIPANTS</th>
                  <th className="pb-4 font-bold text-right">STATUS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredArenas.map((arena) => (
                  <tr key={arena.id} className="group hover:bg-white/5 transition-colors">
                    <td className="py-4">
                      <div className="text-white font-bold">{arena.name}</div>
                      <div className="text-[9px] text-zinc-600 mt-1">{arena.id}</div>
                    </td>
                    <td className="py-4 text-zinc-300">{arena.stake}</td>
                    <td className="py-4 text-center text-zinc-300">{arena.participants}</td>
                    <td className="py-4 text-right">
                      <span className={`px-2 py-0.5 text-[9px] font-bold ${
                        arena.status === 'LIVE' ? 'text-neon-green bg-neon-green/10' :
                        arena.status === 'SETTLING' ? 'text-neon-pink bg-neon-pink/10' :
                        'text-zinc-500 bg-white/5'
                      }`}>
                        {arena.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* History Panel */}
        <div className="border border-white/5 bg-black/20 p-6">
          <h3 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase mb-6">HISTORY_LOG.V3</h3>
          <div className="space-y-4">
            {MOCK_HISTORY.map((item, idx) => (
              <div key={idx} className="group border border-white/5 bg-black/20 p-4 hover:border-white/10 transition-all flex justify-between items-center">
                <div className="space-y-1">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-bold text-zinc-500">ARENA {item.arena}</span>
                    <span className="text-[10px] text-zinc-600">|</span>
                    <span className="text-[10px] text-zinc-400">{item.stake} • {item.rounds}</span>
                  </div>
                  <div className={`text-xs font-bold ${item.success ? 'text-neon-green' : 'text-neon-pink'}`}>
                    {item.pnl}
                  </div>
                </div>
                <div className="text-right">
                  <span className={`text-[9px] font-bold tracking-widest px-2 py-1 ${
                    item.success ? 'bg-neon-green/10 text-neon-green' : 'bg-neon-pink/10 text-neon-pink'
                  }`}>
                    {item.result}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

