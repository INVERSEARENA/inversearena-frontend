import React from 'react';

const YieldShowcase = () => {
    return (
        <section id="yield" className="py-24 px-6 max-w-6xl mx-auto w-full">
            <div className="border-[2px] border-neon-pink p-8 md:p-16 relative overflow-hidden bg-black/20 backdrop-blur-sm">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center relative z-10">
                    <div>
                        <div className="inline-block px-3 py-1 bg-neon-pink text-white text-[9px] font-bold tracking-[0.2em] mb-8 uppercase">
                            RWA INTEGRATION ACTIVE
                        </div>

                        <h2 className="text-5xl md:text-7xl font-extralight tracking-tighter mb-10 leading-[0.95]">
                            <span className="text-white block">WIN EVEN IF</span>
                            <span className="text-neon-pink italic block">YOU LOSE</span>
                        </h2>

                        <div className="space-y-6 max-w-sm">
                            <p className="text-white text-lg font-extralight uppercase tracking-tight family-mono">
                                Your entry fee isn&apos;t just sitting there.
                            </p>

                            <p className="text-zinc-400 font-mono text-[10px] leading-relaxed uppercase font-medium tracking-widest opacity-80">
                                While you play, your capital is deployed into Real-World Assets (RWA) like Treasury bills and private credit. This generates real interest that is credited to your account, ensuring you earn yield regardless of the game&apos;s outcome.
                            </p>
                        </div>

                        <div className="mt-12 pt-6 border-l-[3px] border-neon-pink pl-5">
                            <div className="flex flex-col">
                                <span className="text-neon-pink text-4xl font-extralight tracking-tighter family-mono">+6.4% APY</span>
                                <span className="text-[9px] uppercase tracking-widest text-zinc-500 mt-2 font-bold font-mono">Current Average Treasury Yield</span>
                            </div>
                        </div>
                    </div>

                    {/* Yield Tracker Panel */}
                    <div className="bg-[#09101D] border border-white/5 p-8 rounded-sm relative shadow-2xl">
                        <div className="flex justify-between items-start mb-12">
                            <div>
                                <h4 className="text-[9px] font-bold tracking-[0.3em] text-neon-pink uppercase mb-2">YIELD_TRACKER.V1</h4>
                                <div className="flex items-center gap-3">
                                    <span className="text-[9px] font-mono text-zinc-500 uppercase font-medium tracking-wider">Real-World Assets</span>
                                </div>
                            </div>
                            <div className="text-right">
                                <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest font-medium">Allocation</span>
                            </div>
                        </div>

                        <div className="space-y-10 mb-12">
                            <div>
                                <div className="flex justify-between text-[9px] font-mono text-white mb-2 uppercase font-medium tracking-widest">
                                    <span>T-BILLS (60%)</span>
                                </div>
                                <div className="w-full h-6 bg-black/40 border border-white/5 p-[2px]">
                                    <div className="h-full bg-neon-pink w-[60%]" />
                                </div>
                            </div>

                            <div>
                                <div className="flex justify-between text-[9px] font-mono text-white mb-2 uppercase font-medium tracking-widest">
                                    <span>PRIVATE CREDIT (30%)</span>
                                </div>
                                <div className="w-full h-6 bg-black/40 border border-white/5 p-[2px]">
                                    <div className="h-full bg-zinc-700 w-[30%]" />
                                </div>
                            </div>
                        </div>

                        <div className="pt-8 border-t border-white/5 text-center">
                            <span className="text-[9px] text-zinc-600 uppercase tracking-[0.4em] mb-3 block font-bold">Estimated Daily Payout</span>
                            <span className="text-4xl font-extralight text-neon-green font-mono tracking-tighter">
                                $4,290.12
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default YieldShowcase;
