import React from 'react';

const BottomCta = () => {
    return (
        <section className="py-24 px-6 max-w-5xl mx-auto w-full text-center">
            <div className="bg-[#09101D] border border-white/10 p-16 md:p-24 relative overflow-hidden ring-1 ring-white/5">
                <h2 className="text-4xl md:text-7xl font-extralight tracking-tight mb-2 text-white uppercase leading-none">
                    READY TO BE THE
                </h2>
                <div className="inline-block px-10 py-3 bg-neon-green mb-16">
                    <h2 className="text-4xl md:text-7xl font-bold tracking-tight text-black uppercase leading-none">
                        MINORITY?
                    </h2>
                </div>

                <div className="flex flex-col md:flex-row items-center justify-center gap-6 relative z-10">
                    <button className="w-full md:w-64 py-6 bg-[#1a1a1a] border border-white/10 text-zinc-500 font-bold tracking-[0.2em] text-[10px] uppercase hover:text-neon-green hover:border-neon-green/30 transition-all">
                        ENTER ARENA
                    </button>

                    <button className="w-full md:w-64 py-6 bg-transparent border-[1.5px] border-white text-white font-bold tracking-[0.2em] text-[10px] uppercase hover:bg-white hover:text-black transition-all">
                        READ_DOCS
                    </button>
                </div>

                <p className="mt-16 text-[9px] text-zinc-600 font-mono uppercase tracking-[0.3em] font-medium opacity-60">
                    CONNECT WITH STELLAR ALBEDO OR FREIGHT LINER TO BEGIN.
                </p>
            </div>
        </section>
    );
};

export default BottomCta;
