import React from 'react';

const Footer = () => {
    return (
        <footer className="bg-black pt-24 pb-16 px-6 border-t border-white/5">
            <div className="max-w-6xl mx-auto">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-12 mb-20">
                    {/* Logo and About */}
                    <div className="md:col-span-4">
                        <div className="flex items-center gap-2 mb-8">
                            <div className="w-6 h-6 border border-neon-green flex items-center justify-center p-1">
                                <div className="w-full h-full bg-neon-green" />
                            </div>
                            <div className="text-xl tracking-tighter uppercase font-extralight">
                                <span className="text-white">INVERSE</span>
                                <span className="text-neon-green ml-1">_ARENA</span>
                            </div>
                        </div>
                        <p className="text-[9px] text-zinc-600 font-mono leading-relaxed uppercase font-medium tracking-widest max-w-xs">
                            A DECENTRALIZED GAME THEORY PROTOCOL ON SOROBAN. WHERE STRATEGY MEETS SUSTAINABLE YIELD.
                        </p>
                    </div>

                    {/* Links Column 1 */}
                    <div className="md:col-span-2">
                        <h4 className="text-[9px] font-bold text-neon-green tracking-[0.2em] uppercase mb-8">SYSTEM</h4>
                        <ul className="space-y-4 text-[9px] font-mono text-zinc-400 font-medium tracking-widest uppercase">
                            <li><a href="#" className="hover:text-neon-green transition-colors">STATUS_LOG</a></li>
                            <li><a href="#" className="hover:text-neon-green transition-colors">YIELD_ORACLE</a></li>
                            <li><a href="#" className="hover:text-neon-green transition-colors">SECURITY_AUDIT</a></li>
                        </ul>
                    </div>

                    {/* Links Column 2 */}
                    <div className="md:col-span-2">
                        <h4 className="text-[9px] font-bold text-neon-pink tracking-[0.2em] uppercase mb-8">COMMUNITY</h4>
                        <ul className="space-y-4 text-[9px] font-mono text-zinc-400 font-medium tracking-widest uppercase">
                            <li><a href="#" className="hover:text-neon-pink transition-colors">DISCORD</a></li>
                            <li><a href="#" className="hover:text-neon-pink transition-colors">X_TERMINAL</a></li>
                            <li><a href="#" className="hover:text-neon-pink transition-colors">GOVERNANCE</a></li>
                        </ul>
                    </div>

                    {/* Links Column 3 */}
                    <div className="md:col-span-4">
                        <h4 className="text-[9px] font-bold text-white tracking-[0.2em] uppercase mb-8">LEGAL</h4>
                        <ul className="space-y-4 text-[9px] font-mono text-zinc-700 font-medium tracking-widest uppercase">
                            <li><span>© 2026 INVERSE_ARENA_PROTOCOL</span></li>
                            <li><span>SOROBAN_MAINNET_03</span></li>
                        </ul>
                    </div>
                </div>

                <div className="pt-10 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-1.5 h-1.5 rounded-full bg-neon-green" />
                        <span className="text-[8px] font-mono text-zinc-700 uppercase tracking-[0.3em] font-medium">NETWORK_STATUS: OPTIMAL</span>
                    </div>
                    <div className="text-[8px] font-mono text-zinc-800 uppercase tracking-[0.3em]">
                        built_with_soroban_and_stellar
                    </div>
                </div>
            </div>
        </footer>
    );
};

export default Footer;
