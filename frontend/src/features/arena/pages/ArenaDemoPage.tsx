"use client";

import { ChooseYourFate, ChoiceCard, TensionBar, Timer, TotalYieldPot } from "@/components/arena/core";
import { OnboardingTour } from "@/components/arena-v2/onboarding/OnboardingTour";
import { StatCard } from "@/components/arena-v2/stats/StatCard";
import { EliminationLog } from "@/components/arena-v2/stats/EliminationLog";
import { ArenaFooter } from "@/components/arena-v2/footer/ArenaFooter";

// TODO(#1496): demo-only route backed by local fixtures. Production arena
// state/transactions must come from the canonical /arena feature so demo
// modules stay out of the production arena bundle.
const MOCK_ELIMINATION_LOG = [
  { id: "1", label: "USER 9021 X", status: "terminated" as const },
  { id: "2", label: "ALPHA.BRAVO.9", status: "terminated" as const },
  { id: "3", label: "YOU", status: "active" as const },
];

export default function ArenaV2Page() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[#05080f] px-4 py-6 text-white sm:px-6 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,#12366a_0%,transparent_55%)] opacity-35" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(58,76,103,0.28)_1px,transparent_1px),linear-gradient(90deg,rgba(58,76,103,0.28)_1px,transparent_1px)] bg-[size:40px_40px]" />

      <section className="relative z-10 mx-auto w-full max-w-[1260px] space-y-5">
        <header className="grid gap-4 lg:grid-cols-[1.2fr_1fr_1fr]" data-tour-anchor="center-area">
          <ChooseYourFate />

          <div data-tour-anchor="timer">
            <Timer initialSeconds={5} />
          </div>

          <div data-tour-anchor="yield-pot">
            <TotalYieldPot amount={43850.12} apr={11.8} />
          </div>
        </header>

        <TensionBar headsPercentage={42} tailsPercentage={58} />

        <div className="grid gap-5 md:grid-cols-2" data-tour-anchor="selection-cards">
          <ChoiceCard type="heads" estimatedYield={41} />
          <ChoiceCard type="tails" estimatedYield={59} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard variant="survivors" current={128} total={1024} />
          <StatCard
            variant="potential"
            amount="$2,402"
            subtitle="Stellar/Soroban Network Verified"
          />
          <StatCard variant="elimination" nextCount={64} />
          <EliminationLog entries={MOCK_ELIMINATION_LOG} />
        </div>

        <ArenaFooter />
      </section>

      <OnboardingTour />
    </main>
  );
}
