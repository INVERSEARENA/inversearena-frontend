"use client";

import { useState } from "react";
import { FeaturedArenaCard } from "@/features/dashboard-home/components/FeaturedArenaCard";
import { YieldGeneratorPanel } from "@/features/dashboard-home/components/YieldGeneratorPanel";
import {
  QuickActionTile,
  PlusIcon,
  GridIcon,
} from "@/features/dashboard-home/components/QuickActionTile";
import { GlobalIntelTicker } from "@/features/dashboard-home/components/GlobalIntelTicker";
import { RecentGames } from "@/features/dashboard-home/components/RecentGames";
import { Announcements } from "@/features/dashboard-home/components/Announcements";
import { MetricsPanel } from "@/features/dashboard-home/components/MetricsPanel";
import { PoolCreationModal } from "@/components/modals/PoolCreationModal";
import TelemetryPage from "@/app/dashboard/telemetry-bar/page";

import {
  featuredArena,
  yieldGeneratorData,
  globalIntelItems,
  recentGames,
  activeAnnouncement,
  networkMetrics,
} from "@/features/dashboard-home/mockHome";

export default function DashboardHomePage() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <div className="space-y-6">
      <TelemetryPage/>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* <TelemetryPage/> */}
        <div className="lg:col-span-2">
          <FeaturedArenaCard arena={featuredArena} />
        </div>

        <div className="flex flex-col gap-4">
          <YieldGeneratorPanel data={yieldGeneratorData} />

          <div className="grid grid-cols-2 gap-4">
            <QuickActionTile
              icon={<PlusIcon />}
              label="CREATE NEW ARENA"
              onClick={() => setIsModalOpen(true)}
            />
            <QuickActionTile icon={<GridIcon />} label="BROWSE POOLS" />
          </div>
        </div>
      </div>

      <GlobalIntelTicker items={globalIntelItems} />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <RecentGames games={recentGames} />
        <Announcements announcement={activeAnnouncement} />
        <MetricsPanel metrics={networkMetrics} />
      </div>

      <PoolCreationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onInitialize={(data) => {
          console.log("Initializing pool:", data);
          setIsModalOpen(false);
        }}
      />
    </div>
  );
}
