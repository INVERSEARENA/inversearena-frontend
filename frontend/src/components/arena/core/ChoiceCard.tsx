"use client";

interface ChoiceCardProps {
  type: "heads" | "tails";
  estimatedYield: number;
  isSelected?: boolean;
  onSelect?: () => void;
}

function HeadsIcon() {
  return (
    <svg
      viewBox="0 0 64 64"
      className="w-20 h-20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <ellipse cx="32" cy="32" rx="12" ry="24" />
      <line x1="32" y1="8" x2="32" y2="56" />
      <line x1="20" y1="20" x2="44" y2="20" />
      <line x1="20" y1="44" x2="44" y2="44" />
    </svg>
  );
}

function TailsIcon() {
  return (
    <svg
      viewBox="0 0 64 64"
      className="w-20 h-20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polygon points="32,8 56,24 56,48 32,56 8,48 8,24" />
      <polygon points="32,16 48,28 48,44 32,52 16,44 16,28" />
      <circle cx="32" cy="36" r="6" />
    </svg>
  );
}

export function ChoiceCard({
  type,
  estimatedYield,
  isSelected = false,
  onSelect,
}: ChoiceCardProps) {
  const isHeads = type === "heads";
  const accentColor = isHeads ? "bg-neon-green" : "bg-neon-pink";
  const selectedBorder = isSelected
    ? isHeads
      ? "border-neon-green"
      : "border-neon-pink"
    : "border-zinc-300";

  return (
    <button
      onClick={onSelect}
      className={`
        group relative bg-white w-full py-12 px-8 border-2 ${selectedBorder}
        transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]
        flex flex-col items-center h-full
        ${isSelected ? "ring-2 ring-offset-2 ring-offset-dark-bg" : ""}
        ${isSelected ? (isHeads ? "ring-neon-green" : "ring-neon-pink") : ""}
      `}
    >
      {/* Dashed circle container */}
      <div className="relative flex items-center justify-center mb-8 flex-grow">
        {/* Outer dashed circle */}
        <div
          className="absolute w-56 h-56 rounded-full border-2 border-dashed border-zinc-300"
        />

        {/* Inner solid circle with icon */}
        <div className="w-40 h-40 rounded-full border-2 border-zinc-800 flex items-center justify-center bg-white text-zinc-800">
          {isHeads ? <HeadsIcon /> : <TailsIcon />}
        </div>
      </div>

      {/* Choice name */}
      <h3 className="text-4xl md:text-5xl font-bold text-black tracking-wide mb-6">
        {type.toUpperCase()}
      </h3>

      {/* Estimated yield badge */}
      <div className={`${accentColor} px-4 py-2`}>
        <span className="font-pixel text-[10px] tracking-wider text-black">
          EST. YIELD +{estimatedYield}%
        </span>
      </div>
    </button>
  );
}
