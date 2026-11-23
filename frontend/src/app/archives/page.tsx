"use client"; // Client component required for useState hook managing selected match index

import { useState } from "react"; // React hook for managing local selected-row state
import { ArchivesFilterBar } from "@/components/archives/global/ArchivesFilterBar"; // Category filter buttons component
import { ArchivesHeader } from "@/components/archives/global/ArchivesHeader"; // Page header with breadcrumb and title
import { GlobalPerformanceStats } from "@/components/archives/global/GlobalPerformanceStats"; // Top-level stat cards
import { HistoryTable } from "@/components/archives/table/HistoryTable"; // Match history data table component
import { RoundLogPanel } from "@/components/archives/details/RoundLogPanel"; // Round-by-round detail side panel
import { YieldActionCard } from "@/components/archives/details/YieldActionCard"; // Yield protocol action card

/* ArchivesPage is the main page shell assembling header, stats, filters, table, and detail panels */
export default function ArchivesPage() {
  /* Track the index of the currently selected match row (defaults to first row) */
  const [selectedMatch, setSelectedMatch] = useState(0);

  return (
    /* Full-page wrapper with dark background and responsive padding */
    <div className="min-h-screen bg-[#050B15] px-4 py-6 md:px-8 md:py-8">
      {/* Main content card with dark border and background, constrained to max width */}
      <section className="mx-auto w-full max-w-6xl overflow-hidden border-[3px] border-[#0E1A2D] bg-[#0A1324]">
        {/* Page header component rendering breadcrumb, title, and subtitle */}
        <ArchivesHeader />

        {/* Inner padding wrapper for the stats, filters, and table/detail grid */}
        <div className="px-4 py-5 md:px-8 md:py-6">
          {/* Global performance stats row (total games, highest round, accumulated yield) */}
          <GlobalPerformanceStats />
          {/* Category filter bar (ALL GAMES, VICTORIES, ELIMINATIONS, HOSTED) */}
          <ArchivesFilterBar />

          {/* Two-column grid: left side holds the history table, right side holds round log and yield card */}
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
            {/* Left column: scrollable match history data table */}
            <HistoryTable
              selectedIndex={selectedMatch} // Pass currently selected row index for highlighting
              onSelectMatch={setSelectedMatch} // Callback to update selected row on click
            />

            {/* Right column: stacked round-by-round log and yield protocol card */}
            <div className="flex flex-col gap-4">
              {/* Round-by-round detail panel showing rounds for the selected match */}
              <RoundLogPanel selectedIndex={selectedMatch} />
              {/* Yield protocol action card with RE-INVEST and WITHDRAW buttons */}
              <YieldActionCard />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}