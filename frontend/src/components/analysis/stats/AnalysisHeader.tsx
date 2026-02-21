export function AnalysisHeader() {
  return (
    <header className="border-b-[3px] border-black px-4 py-3 md:px-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-5 items-center justify-center border-2 border-black bg-[#37FF1C]"
          >
            <span className="size-1.5 rounded-full border border-black bg-[#0A0A0A]" />
          </span>

          <h1 className="font-display text-lg font-bold uppercase tracking-tight text-[#1A1F2B] md:text-2xl">
            RWA YIELD PROTOCOL ANALYSIS
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden border-2 border-black bg-black px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#37FF1C] sm:inline-flex">
            LIVE: STELLAR SOROBAN
          </span>

          <button
            type="button"
            aria-label="Close analysis"
            className="inline-flex size-7 items-center justify-center border-2 border-black bg-white font-bold text-black transition-colors hover:bg-zinc-100"
          >
            X
          </button>
        </div>
      </div>

      <span className="mt-2 inline-flex border-2 border-black bg-black px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#37FF1C] sm:hidden">
        LIVE: STELLAR SOROBAN
      </span>
    </header>
  );
}

