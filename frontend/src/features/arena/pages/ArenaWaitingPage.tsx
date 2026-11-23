"use client";

import { QuorumProgress } from "@/components/arena-v2/waiting/QuorumProgress";
import { LiveManifest } from "@/components/arena-v2/waiting/LiveManifest";
import { PreGameIntel } from "@/components/arena-v2/waiting/PreGameIntel";
import { EntryStatsCards } from "@/components/arena-v2/waiting/EntryStatsCards";

export default function WaitingPage() {
    return (
        <div className="min-h-screen bg-background-dark text-white font-display pb-16">
            <main className="max-w-[1400px] mx-auto p-6 space-y-6">
                {/* ── Quorum header + progress bar ── */}
                <QuorumProgress />

                {/* ── Bento grid: Manifest | Stats + Intel ── */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-auto lg:h-[600px]">
                    {/* Left column — participant manifest */}
                    <div className="lg:col-span-5 flex flex-col">
                        <LiveManifest />
                    </div>

                    {/* Right column — stats cards + terminal */}
                    <div className="lg:col-span-7 flex flex-col gap-6">
                        <EntryStatsCards />
                        <PreGameIntel />
                    </div>
                </div>

                {/* ── View All Participants button ── */}
                <div className="flex flex-col items-center gap-4 py-8">
                    <button className="w-full h-24 bg-white text-black text-2xl sm:text-3xl lg:text-4xl font-black neubrutalist-border hover:bg-primary transition-colors uppercase tracking-tight flex items-center justify-center gap-4 group neubrutalist-button font-display">
                        VIEW ALL PARTICIPANTS
                        <span className="material-symbols-outlined text-4xl lg:text-5xl transition-transform group-hover:translate-x-2">
                            arrow_forward
                        </span>
                    </button>
                    <div className="flex items-center gap-4">
                        <span className="text-white/50 font-bold uppercase tracking-[0.3em] text-sm italic font-display">
                            SYSTEM STATUS:
                        </span>
                        <span className="text-primary font-black uppercase tracking-widest text-sm bg-black px-2 py-1 neubrutalist-border font-display">
                            WAITING FOR MINIMUM QUORUM
                        </span>
                    </div>
                </div>
            </main>

            {/* ── Sticky footer ── */}
            <footer className="fixed bottom-0 w-full neubrutalist-border border-x-0 border-b-0 bg-black py-2 px-6 flex justify-between items-center z-50">
                <div className="flex gap-4 sm:gap-8 flex-wrap">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-white/50 uppercase font-display">
                            PLAYERS
                        </span>
                        <span className="text-sm font-black text-primary tabular-nums font-display">
                            72/100
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-white/50 uppercase font-display">
                            TOTAL_STAKED
                        </span>
                        <span className="text-sm font-black text-white font-display">
                            36,000 XLM
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-white/50 uppercase font-display">
                            LATENCY
                        </span>
                        <span className="text-sm font-black text-primary tabular-nums font-display">
                            12ms
                        </span>
                    </div>
                </div>
                <div className="text-[10px] font-black text-white/30 uppercase tracking-widest font-display hidden sm:block">
                    ENCRYPTED_CONNECTION: AES-256-GCM
                </div>
            </footer>
        </div>
    );
}
