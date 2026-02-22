"use client";

import { motion } from "motion/react";
import { Wallet } from "lucide-react";
import { YieldPerformanceChart } from "@/components/analysis/charts/YieldPerformanceChart";
import { YieldEventLog } from "@/components/analysis/logs/YieldEventLog";
import { AnalysisFooter } from "@/components/analysis/stats/AnalysisFooter";
import { AnalysisHeader } from "@/components/analysis/stats/AnalysisHeader";
import { StatsGrid } from "@/components/analysis/stats/StatsGrid";

export default function AnalysisPage() {
  return (
    <div className="min-h-screen bg-[#071122] px-4 py-8 md:px-8">
      <section className="mx-auto w-full max-w-6xl border-[3px] border-black bg-white shadow-[8px_8px_0_#000]">
        <AnalysisHeader />
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
            <YieldPerformanceChart />
          </motion.div>
          <motion.div
            className="min-h-[280px] md:h-[320px]"
            variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
          >
            <YieldEventLog />
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

