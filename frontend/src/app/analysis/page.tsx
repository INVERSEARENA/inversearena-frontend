"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import { Wallet } from "lucide-react";
import { YieldPerformanceChart } from "@/components/analysis/charts/YieldPerformanceChart";
import { YieldEventLog, type YieldEvent } from "@/components/analysis/logs/YieldEventLog";
import { AnalysisFooter } from "@/components/analysis/stats/AnalysisFooter";
import { AnalysisHeader } from "@/components/analysis/stats/AnalysisHeader";
import { StatsGrid } from "@/components/analysis/stats/StatsGrid";
import { useArenaYield } from "@/features/yield";

function AnalysisContent() {
  const searchParams = useSearchParams();
  const initialArena = searchParams.get("arena") ?? "";
  const [arenaInput, setArenaInput] = useState(initialArena);
  const [arenaId, setArenaId] = useState<string | null>(
    initialArena || null,
  );

  const { points, asset, loading, error, refetch } = useArenaYield(arenaId);

  const applyArena = useCallback(() => {
    const next = arenaInput.trim() || null;
    setArenaId(next);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (next) {
        params.set("arena", next);
      } else {
        params.delete("arena");
      }
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}`,
      );
    }
  }, [arenaInput]);

  // Chart: cumulative yield per resolved round (#1568).
  const chartData = useMemo(
    () =>
      points.map((p) => ({
        time: `R${p.round}`,
        yield: Number(p.cumulative),
      })),
    [points],
  );

  // Event log: one entry per yield snapshot, newest first (#1568).
  const events: YieldEvent[] = useMemo(
    () =>
      [...points].reverse().map((p) => ({
        id: `round-${p.round}`,
        timestamp: p.timestamp.replace("T", " ").slice(0, 19),
        earnings: p.accrued,
        status: "OK" as const,
      })),
    [points],
  );

  return (
    <div className="min-h-screen bg-[#071122] px-4 py-8 md:px-8">
      <section className="mx-auto w-full max-w-6xl border-[3px] border-black bg-white shadow-[8px_8px_0_#000]">
        <AnalysisHeader />

        {/* Arena selector: per-arena yield series (#1568) */}
        <div className="flex flex-col gap-2 px-4 md:flex-row md:items-center md:px-6">
          <label
            htmlFor="arena-id"
            className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-black"
          >
            Arena ID
          </label>
          <input
            id="arena-id"
            type="text"
            value={arenaInput}
            onChange={(e) => setArenaInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyArena();
            }}
            placeholder="Enter arena ID to load its yield series"
            className="h-11 flex-1 border-[3px] border-black bg-white px-3 font-mono text-sm text-black placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-black"
          />
          <button
            type="button"
            onClick={applyArena}
            className="inline-flex h-11 items-center justify-center border-[3px] border-black bg-black px-5 font-display text-xs font-bold uppercase tracking-[0.08em] text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
          >
            Load
          </button>
        </div>

        {loading && (
          <p className="px-4 pt-3 font-mono text-xs text-black md:px-6" role="status">
            Loading yield series…
          </p>
        )}
        {error && (
          <div className="flex flex-col gap-2 px-4 pt-3 sm:flex-row sm:items-center md:px-6">
            <p className="font-mono text-xs text-red-600" role="alert">{error}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="w-fit border-2 border-red-600 px-4 py-1.5 font-mono text-xs uppercase tracking-[0.2em] text-red-600"
            >
              Retry
            </button>
          </div>
        )}
        {!arenaId && !loading && (
          <p className="px-4 pt-3 font-mono text-xs text-zinc-600 md:px-6">
            Enter an arena ID above to load its real per-round yield series{asset ? ` (${asset})` : ""}.
            Shareable via ?arena=&lt;id&gt;.
          </p>
        )}
        {arenaId && !loading && !error && points.length === 0 && (
          <p className="px-4 pt-3 font-mono text-xs text-zinc-600 md:px-6" role="status">
            No resolved rounds yet for this arena — the series appears after the first on-chain resolution.
          </p>
        )}

        <StatsGrid />

        <motion.div
          className="grid grid-cols-1 gap-3 px-4 md:grid-cols-2 md:grid-rows-1 md:px-6"
          initial="hidden"
          animate="visible"
          variants={{
            visible: { transition: { staggerChildren: 0.06 } },
            hidden: {},
          }}
        >
          <motion.div
            className="min-h-[280px] md:h-[320px]"
            variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
          >
            <YieldPerformanceChart data={chartData} />
          </motion.div>
          <motion.div
            className="min-h-[280px] md:h-[320px]"
            variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
          >
            <YieldEventLog events={events} />
          </motion.div>
        </motion.div>

        <motion.div
          className="grid grid-cols-1 gap-3 px-4 pt-6 pb-4 md:grid-cols-2 md:px-6 md:pt-8 md:pb-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.3 }}
        >
          <motion.button
            type="button"
            className="inline-flex h-14 items-center justify-center gap-2 border-[3px] border-black bg-[#37FF1C] px-5 font-display text-sm font-bold uppercase tracking-[0.08em] text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
            whileHover={{
              scale: 1.02,
              backgroundColor: "#2fe015",
              boxShadow: "0 0 24px rgba(55, 255, 28, 0.4), 8px 8px 0 #000",
              transition: { duration: 0.2 },
            }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.15 }}
          >
            <Wallet aria-hidden className="size-5 shrink-0" strokeWidth={2.5} />
            WITHDRAW YIELD
          </motion.button>

          <motion.button
            type="button"
            className="inline-flex h-14 items-center justify-center gap-2 border-[3px] border-black bg-white px-5 font-display text-sm font-bold uppercase tracking-[0.08em] text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
            whileHover={{
              scale: 1.02,
              backgroundColor: "rgb(244 244 245)",
              transition: { duration: 0.2 },
            }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.15 }}
          >
            <span aria-hidden className="font-mono text-base">
              {"<"}
            </span>
            BACK TO PROFILE
          </motion.button>
        </motion.div>

        <AnalysisFooter />
      </section>
    </div>
  );
}

export default function AnalysisPage() {
  return (
    <Suspense>
      <AnalysisContent />
    </Suspense>
  );
}
