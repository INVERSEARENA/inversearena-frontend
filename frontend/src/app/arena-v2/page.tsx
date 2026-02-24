import { ChooseYourFate, ChoiceCard, TensionBar, Timer, TotalYieldPot } from "@/components/arena/core";
import { OnboardingTour } from "@/components/arena-v2/onboarding/OnboardingTour";

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

        <footer className="grid gap-4 rounded-sm border border-white/20 bg-black/55 p-4 font-display text-xs tracking-[0.16em] text-white/70 sm:grid-cols-3">
          <div>
            <p className="mb-1 text-[10px] uppercase text-white/40">Round Pool</p>
            <p className="font-pixel text-lg text-neon-green">$128,221.35</p>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase text-white/40">Players In</p>
            <p className="font-pixel text-lg text-white">512 / 1024</p>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase text-white/40">Protocol</p>
            <p className="font-pixel text-lg text-neon-green">Majority Eliminated</p>
          </div>
        </footer>
      </section>

      <OnboardingTour />
    </main>
  );
}
