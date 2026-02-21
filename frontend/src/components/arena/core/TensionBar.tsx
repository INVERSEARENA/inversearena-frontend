"use client";

interface TensionBarProps {
  headsPercentage: number;
  tailsPercentage: number;
}

export function TensionBar({ headsPercentage, tailsPercentage }: TensionBarProps) {
  return (
    <div className="bg-card-bg border border-border-gray p-4">
      {/* Labels */}
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-2">
          <span className="text-neon-green text-lg">&#9889;</span>
          <span className="text-[10px] font-mono tracking-wider text-white/80 uppercase">
            Heads ({headsPercentage}%)
          </span>
        </div>

        <span className="text-[10px] font-mono tracking-[0.3em] text-white/40 uppercase">
          Population Tension
        </span>

        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-white/80 uppercase">
            Tails ({tailsPercentage}%)
          </span>
          <span className="text-neon-pink text-lg">&#9889;</span>
        </div>
      </div>

      {/* Bar */}
      <div className="relative h-6 flex rounded-sm overflow-hidden">
        {/* Heads side (green) */}
        <div
          className="bg-neon-green h-full transition-all duration-500"
          style={{ width: `${headsPercentage}%` }}
        />

        {/* VS badge */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-dark-bg px-2 py-0.5 border border-border-gray z-10">
          <span className="text-[10px] font-mono font-bold text-white/60">vs</span>
        </div>

        {/* Tails side (pink) */}
        <div
          className="bg-neon-pink h-full transition-all duration-500"
          style={{ width: `${tailsPercentage}%` }}
        />
      </div>
    </div>
  );
}
