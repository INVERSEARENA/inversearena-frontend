"use client";

export type StatCardVariant = "survivors" | "potential" | "elimination";

interface SurvivorsCardProps {
  variant: "survivors";
  current: number;
  total: number;
}

interface PotentialCardProps {
  variant: "potential";
  amount: string;
  subtitle?: string;
}

interface EliminationCardProps {
  variant: "elimination";
  nextCount: number;
}

type StatCardProps = SurvivorsCardProps | PotentialCardProps | EliminationCardProps;

function LadybugIcon() {
  return (
    <svg viewBox="0 0 64 64" className="w-20 h-20 opacity-80" fill="currentColor">
      <ellipse cx="32" cy="36" rx="18" ry="20" />
      <circle cx="32" cy="18" r="10" />
      <line x1="32" y1="16" x2="32" y2="56" stroke="white" strokeWidth="2" />
      <circle cx="22" cy="32" r="4" fill="white" />
      <circle cx="42" cy="32" r="4" fill="white" />
      <circle cx="20" cy="44" r="3" fill="white" />
      <circle cx="44" cy="44" r="3" fill="white" />
      <circle cx="32" cy="16" r="3" fill="black" />
    </svg>
  );
}

export function StatCard(props: StatCardProps) {
  if (props.variant === "survivors") {
    const { current, total } = props;
    const progress = (current / total) * 100;
    return (
      <div className="bg-white p-5 flex flex-col justify-between min-h-[130px]">
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-black/50">
          Active Survivors
        </p>
        <p className="font-pixel text-4xl font-bold text-black mt-1">
          {current.toLocaleString()}{" "}
          <span className="text-xl text-black/40">/ {total.toLocaleString()}</span>
        </p>
        <div className="mt-3 h-1.5 w-full bg-black/10">
          <div
            className="h-full bg-neon-green"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    );
  }

  if (props.variant === "potential") {
    const { amount, subtitle } = props;
    return (
      <div className="bg-black border border-neon-green/30 p-5 flex flex-col justify-between min-h-[130px]">
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-neon-green/60">
          Round Potential
        </p>
        <p className="font-pixel text-4xl font-bold text-neon-green mt-1">{amount}</p>
        {subtitle && (
          <p className="mt-2 text-[9px] tracking-[0.15em] uppercase text-neon-green/40">
            {subtitle}
          </p>
        )}
      </div>
    );
  }

  // elimination
  const { nextCount } = props;
  return (
    <div className="bg-neon-pink p-5 flex flex-col justify-between min-h-[130px] relative overflow-hidden">
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-white/80">
        Next Elimination
      </p>
      <p className="font-pixel text-4xl font-bold text-white mt-1 leading-tight">
        {nextCount.toLocaleString()}
        <br />
        <span className="text-3xl">PLAYERS</span>
      </p>
      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30">
        <LadybugIcon />
      </div>
    </div>
  );
}
