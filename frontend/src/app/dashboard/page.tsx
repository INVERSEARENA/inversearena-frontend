"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ErrorBoundary } from "@/components/error-boundary/ErrorBoundary";
import { ErrorFallback } from "@/components/error-boundary/ErrorFallback";
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
import { ClaimInboxPanel } from "@/features/claim-inbox/components/ClaimInboxPanel";
import { PoolCreationModal } from "@/components/modals/PoolCreationModal";
import {
  fetchRematchConfig,
  toRematchFormPrefill,
  type RematchConfig,
} from "@/features/pools/model/rematch-config";
import StakeModal from "@/components/modals/StakeModal";
import { PayoutTimeline } from "@/app/dashboard/payouts/PayoutTimeline";
import { GlobalTelemetryBar } from "@/app/dashboard/telemetry-bar/page";

import {
  featuredArena,
  yieldGeneratorData,
  globalIntelItems,
  recentGames,
  activeAnnouncement,
} from "@/features/dashboard-home/model/mockHome";

const HAS_STAKED_KEY = "inversearena_has_staked";

export default function DashboardHomePage() {
  return (
    <ErrorBoundary fallback={<ErrorFallback context="dashboard" />}>
      <DashboardHomeView />
    </ErrorBoundary>
  );
}

function DashboardHomeView() {
  const router = useRouter();
  const [isStakeModalOpen, setIsStakeModalOpen] = useState(false);
  const [isPoolModalOpen, setIsPoolModalOpen] = useState(false);
  const [hasStaked, setHasStaked] = useState(false);
  const [timelineTransactionId, setTimelineTransactionId] = useState<string | null>(null);
  // #1572: a result page links here with ?rematch=<sourceArenaId>; the modal
  // opens prefilled from that arena's canonical on-chain config.
  const [rematch, setRematch] = useState<RematchConfig | null>(null);

  useEffect(() => {
    const stored = typeof window !== "undefined" && localStorage.getItem(HAS_STAKED_KEY);
    setHasStaked(stored === "true");
    const params = new URLSearchParams(window.location.search);
    setTimelineTransactionId(params.get("payoutTransactionId"));

    const rematchArenaId = params.get("rematch");
    if (!rematchArenaId) return;
    let cancelled = false;
    fetchRematchConfig(rematchArenaId)
      .then((config) => {
        if (cancelled) return;
        setRematch(config);
        if (toRematchFormPrefill(config)) setIsPoolModalOpen(true);
      })
      .catch(() => {
        // A blocked or unreadable rematch degrades to the normal create flow.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreateArenaClick = () => {
    if (hasStaked) {
      setIsPoolModalOpen(true);
    } else {
      setIsStakeModalOpen(true);
    }
  };

  const handleStakeSuccess = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem(HAS_STAKED_KEY, "true");
    }
    setHasStaked(true);
    setIsStakeModalOpen(false);
    setIsPoolModalOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="-mx-6 -mt-6">
        <GlobalTelemetryBar />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <FeaturedArenaCard arena={featuredArena} />
        </div>

        <div className="flex flex-col gap-4">
          <YieldGeneratorPanel data={yieldGeneratorData} />

          <div className="grid grid-cols-2 gap-4">
            <QuickActionTile
              icon={<PlusIcon />}
              label="CREATE NEW ARENA"
              onClick={handleCreateArenaClick}
            />
            <QuickActionTile
              icon={<GridIcon />}
              label="BROWSE POOLS"
              onClick={() => router.push("/dashboard/games")}
            />
          </div>
        </div>
      </div>

      <GlobalIntelTicker items={globalIntelItems} />
      {timelineTransactionId && <PayoutTimeline transactionId={timelineTransactionId} />}

      {/* Full width: the inbox is a list, and it is the one panel whose rows
          carry a per-item state the user has to be able to read at a glance. */}
      <div className="grid grid-cols-1 gap-6">
        <ClaimInboxPanel />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <RecentGames games={recentGames} />
        <Announcements announcement={activeAnnouncement} />
        <MetricsPanel />
      </div>

      <StakeModal
        isOpen={isStakeModalOpen}
        onClose={() => setIsStakeModalOpen(false)}
        onSuccess={handleStakeSuccess}
      />

      <PoolCreationModal
        isOpen={isPoolModalOpen}
        onClose={() => {
          setIsPoolModalOpen(false);
          setRematch(null);
        }}
        onInitialize={() => {
          setIsPoolModalOpen(false);
          setRematch(null);
        }}
        rematch={rematch}
      />
    </div>
  );
}
