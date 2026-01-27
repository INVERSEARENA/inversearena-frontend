import { ConnectWalletButton } from '@/components/wallet/ConnectWalletButton';
import React from 'react';

const Navbar = () => {
    return (
        <nav className="fixed top-0 left-0 right-0 z-50">
           

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

                    <ConnectWalletButton className="bg-[#39ff14] px-6 py-2 text-[10px] font-bold uppercase text-black hover:bg-white transition-all transform active:scale-95 rounded-none" />
                </div>
            </div>
        </nav>
    );
};

export default Navbar;
