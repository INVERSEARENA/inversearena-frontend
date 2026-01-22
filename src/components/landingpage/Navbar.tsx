import React from 'react';

const Navbar = () => {
    return (
        <nav className="fixed top-0 left-0 right-0 z-50">
            {/* Top Status Bar */}
            <div className="bg-black border-b border-white/10 px-6 py-2 flex justify-between items-center text-[9px] font-mono tracking-[0.2em]">
                <div className="hidden md:flex gap-6">
                    <div className="flex items-center gap-2 text-neon-green font-bold">
                        <div className="w-2 h-2 bg-neon-green" />
                        SYSTEM READY
                    </div>
                    <div className="text-zinc-500 uppercase">SECURE_MODE: STELLAR_SOROBAN</div>
                </div>
                <div className="flex gap-6 text-zinc-500 items-center">
                    <div className="font-medium">
                        YIELD_GEN_ACTIVE: <span className="text-neon-pink">8.4% APY</span>{" "}
                        {"//"}
                    </div>
                    <div className="hidden lg:block font-medium">
                        GLOBAL_POOL: <span className="text-white">1,630,903 USDC</span>{" "}
                        {"//"}
                    </div>
                    <div className="flex items-center gap-1.5 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-neon-pink" />
                        ROUND_#842_PENDING
                    </div>
                </div>
            </div>

            {/* Main Navbar */}
            <div className="bg-black/95 backdrop-blur-xl border-b border-white/5 h-16">
                <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 border border-neon-green flex items-center justify-center p-1.5">
                            <div className="w-full h-full bg-neon-green" />
                        </div>
                        <div className="flex text-lg tracking-tighter uppercase font-extralight">
                            <span className="text-white">INVERSE</span>
                            <span className="text-neon-green ml-1">ARENA</span>
                        </div>
                    </div>

                    <div className="hidden md:flex items-center gap-8">
                        <a href="#protocol" className="text-[10px] font-medium tracking-widest text-zinc-400 hover:text-white transition-colors uppercase">The_Protocol</a>
                        <a href="#why" className="text-[10px] font-medium tracking-widest text-zinc-400 hover:text-white transition-colors uppercase">Why_Inverse?</a>
                        <a href="#yield" className="text-[10px] font-medium tracking-widest text-zinc-400 hover:text-white transition-colors uppercase">Win_Or_Lose</a>
                    </div>

                    <button className="bg-neon-green px-6 py-2 text-[10px] font-bold uppercase text-black hover:bg-white transition-all transform active:scale-95">
                        Connect_Wallet
                    </button>
                </div>
            </div>
        </nav>
    );
};

export default Navbar;
