"use client";

import { useState, useCallback } from "react";
import {
  LeaderboardTable,
  Pagination,
  getPaginatedSurvivors,
  getTotalPages,
} from "@/features/leaderboard";

const ITEMS_PER_PAGE = 4;

const leaderboardStats = {
  totalYield: "$450,230",
  liveAgents: "1,204",
};

const podium = [
  {
    rank: 2,
    name: "AGENT_K...RP9I",
    totalYield: "$1,240.50",
    currency: "USDC",
    highlight: false,
  },
  {
    rank: 1,
    name: "AGENT_G...X4Y2",
    totalYield: "$1,500.00",
    streak: "24 Rounds",
    currency: "USDC",
    highlight: true,
  },
  {
    rank: 3,
    name: "AGENT_M...L2W7",
    totalYield: "$980.20",
    currency: "USDC",
    highlight: false,
  },
];

export default function LeaderboardPage() {
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = getTotalPages(ITEMS_PER_PAGE);
  const paginatedSurvivors = getPaginatedSurvivors(currentPage, ITEMS_PER_PAGE);

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const handleChallenge = useCallback((survivorId: string) => {
    // TODO: connect to smart contract
    console.log("Challenge initiated for survivor:", survivorId);
  }, []);

  return (
    <div className="flex min-h-[calc(100vh-48px)] flex-col gap-8">
      {/* Header & Podium Section */}
      <section className="relative w-full overflow-hidden border border-[#0E1626] bg-[#0A101A] p-6 md:p-10">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0D182A] via-transparent to-transparent" />

        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white italic leading-[0.95]">
                TOP SURVIVORS
              </h1>
            </div>
            <p className="mt-3 text-xs md:text-sm font-mono font-semibold uppercase tracking-[0.2em] text-[#8D909A] max-w-md">
              RWA YIELD LEADERBOARD — STELLAR
              <br className="hidden md:block" />
              SOROBAN NETWORK
            </p>
          </div>

          <div className="grid w-full max-w-sm grid-cols-2 gap-4">
            <div className="border-[3px] border-[#0F1B2D] bg-black px-4 py-4 min-h-[88px]">
              <p className="text-[8px] font-mono uppercase tracking-[0.2em] text-zinc-500">
                TOTAL YIELD
              </p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {leaderboardStats.totalYield}
              </p>
            </div>
            <div className="border-[3px] border-[#37FF1C] bg-[#37FF1C] px-4 py-4 min-h-[88px]">
              <p className="text-[8px] font-mono uppercase tracking-[0.2em] text-black/80">
                LIVE AGENTS
              </p>
              <p className="mt-2 text-2xl font-semibold text-black">
                {leaderboardStats.liveAgents}
              </p>
            </div>
          </div>
        </div>

        <div className="relative z-10 mt-6 h-[4px] w-full bg-gradient-to-r from-transparent via-black/70 to-transparent" />

        <div className="relative z-10 mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3 lg:items-end">
          {podium.map((survivor) => (
            <div
              key={survivor.rank}
              className={`relative flex flex-col justify-between border ${
                survivor.highlight
                  ? "border-[#37FF1C] bg-black shadow-[0_0_35px_rgba(55,255,28,0.25)] lg:min-h-[340px]"
                  : "border-[#0F1B2D] bg-[#172235] lg:min-h-[270px]"
              } px-5 py-5 md:px-6 md:py-6`}
            >
              <div className="relative min-h-[28px]">
                {survivor.highlight ? (
                  <div className="flex items-start justify-between">
                    <span className="text-2xl font-bold text-[#37FF1C]">
                      #{survivor.rank}
                    </span>
                    <span className="relative bg-[#37FF1C] px-2.5 py-0.5 text-[8px] font-mono uppercase tracking-[0.2em] text-black">
                      GRAND SURVIVOR
                    </span>
                    <span className="absolute -right-2 top-0 h-3 w-3 rotate-45 bg-[#37FF1C]" />
                  </div>
                ) : (
                  <span className="absolute right-4 top-0 text-3xl font-bold text-[#2B4B77]">
                    #{survivor.rank}
                  </span>
                )}
              </div>

              <div className={`${survivor.highlight ? "mt-5" : "mt-10"} flex items-center gap-4`}>
                <div
                  className={`${
                    survivor.highlight ? "h-16 w-16" : "h-12 w-12"
                  } shrink-0 border ${
                    survivor.highlight
                      ? "border-[#37FF1C] bg-gradient-to-br from-[#0D2B12] via-[#0D1A12] to-black"
                      : "border-[#1B2636] bg-gradient-to-br from-[#0C1727] via-[#0D1118] to-black"
                  }`}
                />
                <div>
                  <p
                    className={`${survivor.highlight ? "text-lg italic" : "text-sm"} font-semibold text-white`}
                  >
                    {survivor.name}
                  </p>
                  <p className="mt-1 text-[8px] font-mono uppercase tracking-[0.25em] text-zinc-500">
                    TOTAL YIELD
                  </p>
                </div>
              </div>

              {survivor.highlight ? (
                <>
                  <div className="mt-5 h-px w-full bg-white/10" />
                  <div className="mt-4 grid grid-cols-2 gap-6">
                    <div>
                      <p className="text-[8px] font-mono uppercase tracking-[0.25em] text-zinc-500">
                        YIELD GENERATED
                      </p>
                      <p className="mt-1 text-lg font-semibold text-[#37FF1C]">
                        {survivor.totalYield}
                      </p>
                      <p className="text-[8px] font-mono uppercase tracking-[0.25em] text-zinc-500">
                        {survivor.currency}
                      </p>
                    </div>
                    <div>
                      <p className="text-[8px] font-mono uppercase tracking-[0.25em] text-zinc-500">
                        STREAK
                      </p>
                      <p className="mt-1 text-lg font-semibold text-white">
                        {survivor.streak}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-auto pt-6">
                  <p className="text-lg font-semibold text-[#37FF1C]">
                    {survivor.totalYield}
                  </p>
                  <p className="text-[8px] font-mono uppercase tracking-[0.25em] text-zinc-500">
                    {survivor.currency}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Rankings Table Section */}
      <LeaderboardTable
        survivors={paginatedSurvivors}
        onChallenge={handleChallenge}
      />

      {/* Pagination */}
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={handlePageChange}
      />
    </div>
  );
}
