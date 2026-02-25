"use client";

import { useState } from "react";
import { SelectionCard } from "@/components/arena-v2/choice/SelectionCard";
import { TensionBar } from "@/components/arena-v2/tension/TensionBar";

export default function ArenaV2Page() {
  const [selected, setSelected] = useState<"heads" | "tails" | null>(null);

  return (
    <div className="min-h-screen bg-[#07111a] text-white p-10 relative font-sans overflow-x-hidden" 
         style={{ backgroundImage: 'linear-gradient(#111d2b 1.5px, transparent 1.5px), linear-gradient(90deg, #111d2b 1.5px, transparent 1.5px)', backgroundSize: '45px 45px' }}>
      
      {/* HEADER SECTION - Centered Alignment */}
      <div className="flex justify-between items-center mb-10 px-2">
        <div className="uppercase italic font-[1000] text-[48px] leading-[0.85] tracking-tighter">
          <div className="text-white">CHOOSE</div>
          <div className="text-[#3CFF1A]">YOUR FATE</div>
        </div>

        <div className="flex flex-col items-center">
          <span className="text-[10px] font-mono tracking-[0.4em] text-gray-500 uppercase mb-2">Round Locking In</span>
          <div className="bg-white p-6 shadow-[10px_10px_0px_#000] border-b-[8px] border-gray-300 w-80">
            <div className="text-7xl font-mono font-black text-[#f0a3a3] text-center tabular-nums leading-none tracking-tighter">00:05</div>
            <div className="mt-4 h-2 w-full bg-gray-100"><div className="h-full bg-[#FF0A54] w-3/4" /></div>
          </div>
        </div>

        <div className="bg-[#3CFF1A] p-5 border-2 border-black shadow-[8px_8px_0px_#000] min-w-[240px]">
          <p className="text-[10px] font-bold text-black/40 uppercase font-mono mb-1">Current Yield Pot</p>
          <p className="text-3xl font-mono font-[1000] text-black tracking-tight">$42,850.12</p>
        </div>
      </div>

      {/* TENSION BAR */}
      <div className="mb-10 px-2"><TensionBar headsPercentage={42} tailsPercentage={58} /></div>

      {/* CARDS */}
      <div className="grid grid-cols-2 gap-10 mb-12 px-2">
        <SelectionCard type="heads" yieldPercentage={88} isSelected={selected === "heads"} onSelect={() => setSelected("heads")} />
        <SelectionCard type="tails" yieldPercentage={72} isSelected={selected === "tails"} onSelect={() => setSelected("tails")} />
      </div>

      {/* BOTTOM ROW - ASYMMETRICAL (Log = 5/12) */}
      <div className="grid grid-cols-12 gap-5 px-2 mb-20">
        <div className="col-span-2 bg-white p-6 shadow-[8px_8px_0px_#000] text-black border-b-[6px] border-gray-300">
          <p className="text-[10px] font-mono font-bold text-gray-400 uppercase mb-2">Active Survivors</p>
          <p className="text-4xl font-[1000] font-mono">128 <span className="text-xl text-gray-300">/ 1024</span></p>
          <div className="mt-6 h-2 bg-gray-100"><div className="h-full bg-black w-1/4" /></div>
        </div>

        <div className="col-span-2 bg-black p-6 shadow-[8px_8px_0px_#000] border-r-2 border-b-2 border-gray-800">
          <p className="text-[10px] font-mono text-[#3CFF1A] uppercase mb-1">Round Potential</p>
          <p className="text-4xl font-mono font-[1000] text-[#3CFF1A]">$2,402</p>
          <p className="text-[8px] font-mono text-gray-600 mt-2 uppercase">Verified Soroban Network</p>
        </div>

        <div className="col-span-3 bg-[#FF4D6D] p-6 shadow-[8px_8px_0px_#000] relative overflow-hidden">
          <p className="text-[10px] font-mono text-black font-bold uppercase mb-1">Next Elimination</p>
          <p className="text-[44px] font-[1000] text-black leading-none uppercase">64<br/>Players</p>
          <div className="absolute -bottom-4 -right-2 text-8xl opacity-20 rotate-12 italic">💀</div>
        </div>

        <div className="col-span-5 bg-white p-6 shadow-[8px_8px_0px_#000] text-black font-mono text-[10px] flex flex-col">
          <div className="flex justify-between border-b border-gray-200 pb-2 mb-3 font-black uppercase"><span>🕒 Elimination Log</span></div>
          <div className="space-y-2">
            <div className="flex justify-between text-gray-400 font-bold uppercase"><span>USER_0921_X</span> <span>TERMINATED</span></div>
            <div className="flex justify-between text-gray-400 font-bold uppercase"><span>ALPHA_BRAVO_9</span> <span>TERMINATED</span></div>
            <div className="flex justify-between font-black mt-1"><span>YOU</span> <span className="bg-[#3CFF1A] px-2 py-0.5">ACTIVE</span></div>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div className="fixed bottom-0 left-0 w-full bg-black border-t-2 border-gray-900 p-4 px-10 flex justify-between items-center text-[10px] font-mono uppercase tracking-widest">
         <div className="text-[#3CFF1A] font-black flex items-center gap-2">
           <span className="w-2.5 h-2.5 rounded-full bg-[#3CFF1A] animate-pulse" /> ET CONNECTED
         </div>
         <div className="text-[#FF0A54] font-[1000] italic">High Voltage Arena: Play at your own risk</div>
         <div className="text-gray-500">OR: <span className="text-white">0.00%</span></div>
      </div>
    </div>
  );
}
import { ChooseYourFate, ChoiceCard, TensionBar, Timer, TotalYieldPot } from "@/components/arena/core";
import { OnboardingTour } from "@/components/arena-v2/onboarding/OnboardingTour";

export default function ArenaV2Page() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[#05080f] px-4 py-6 text-white sm:px-6 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,#12366a_0%,transparent_55%)] opacity-35" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(58,76,103,0.28)_1px,transparent_1px),linear-gradient(90deg,rgba(58,76,103,0.28)_1px,transparent_1px)] bg-[size:40px_40px]" />

      <section className="relative z-10 mx-auto w-full max-w-[1260px] space-y-5">
        <header className="grid gap-4 lg:grid-cols-[1.2fr_1fr_1fr]" data-tour-anchor="center-area">
          <ChooseYourFate />

          <div data-tour-anchor="timer">
            <Timer initialSeconds={5} />
          </div>

          <div data-tour-anchor="yield-pot">
            <TotalYieldPot amount={43850.12} apr={11.8} />
          </div>
        </header>

        <TensionBar headsPercentage={42} tailsPercentage={58} />

        <div className="grid gap-5 md:grid-cols-2" data-tour-anchor="selection-cards">
          <ChoiceCard type="heads" estimatedYield={41} />
          <ChoiceCard type="tails" estimatedYield={59} />
        </div>

        <footer className="grid gap-4 rounded-sm border border-white/20 bg-black/55 p-4 font-display text-xs tracking-[0.16em] text-white/70 sm:grid-cols-3">
          <div>
            <p className="mb-1 text-[10px] uppercase text-white/40">Round Pool</p>
            <p className="font-pixel text-lg text-neon-green">$128,221.35</p>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase text-white/40">Players In</p>
            <p className="font-pixel text-lg text-white">512 / 1024</p>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase text-white/40">Protocol</p>
            <p className="font-pixel text-lg text-neon-green">Majority Eliminated</p>
          </div>
        </footer>
      </section>

      <OnboardingTour />
    </main>
  );
}
