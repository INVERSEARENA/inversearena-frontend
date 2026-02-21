import { AnalysisFooter } from "@/components/analysis/stats/AnalysisFooter";
import { AnalysisHeader } from "@/components/analysis/stats/AnalysisHeader";
import { StatsGrid } from "@/components/analysis/stats/StatsGrid";

export default function AnalysisPage() {
  return (
    <div className="min-h-screen bg-[#071122] px-4 py-8 md:px-8">
      <section className="mx-auto w-full max-w-6xl border-[3px] border-black bg-white shadow-[8px_8px_0_#000]">
        <AnalysisHeader />
        <StatsGrid />

        <div className="grid grid-cols-1 gap-3 px-4 pb-4 md:grid-cols-2 md:px-6 md:pb-6">
          <button
            type="button"
            className="inline-flex h-14 items-center justify-center gap-2 border-[3px] border-black bg-[#37FF1C] px-5 font-display text-sm font-bold uppercase tracking-[0.08em] text-black transition-colors hover:bg-[#2fe015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
          >
            <span aria-hidden className="font-mono text-base">
              v
            </span>
            WITHDRAW YIELD
          </button>

          <button
            type="button"
            className="inline-flex h-14 items-center justify-center gap-2 border-[3px] border-black bg-white px-5 font-display text-sm font-bold uppercase tracking-[0.08em] text-black transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
          >
            <span aria-hidden className="font-mono text-base">
              {"<"}
            </span>
            BACK TO PROFILE
          </button>
        </div>

        <AnalysisFooter />
      </section>
    </div>
  );
}

