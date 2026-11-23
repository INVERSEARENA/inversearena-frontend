"use client";

interface SelectionCardProps {
  type: "heads" | "tails";
  yieldPercentage: number;
  isSelected?: boolean;
  onSelect?: () => void;
}

export function SelectionCard({ type, yieldPercentage, isSelected, onSelect }: SelectionCardProps) {
  const isHeads = type === "heads";
  const neon = isHeads ? "#3CFF1A" : "#FF0A54";

  return (
    <button
      onClick={onSelect}
      className="relative w-full bg-[#09121d] p-16 border-[5px] transition-all duration-300 group overflow-hidden"
      style={{
        borderColor: isSelected ? neon : "#000",
        boxShadow: isSelected ? `0 0 40px ${neon}44` : "10px 10px 0px #000",
      }}
    >
      {/* Corner Accents */}
      <div className="absolute top-6 left-6 flex flex-col gap-1.5">
        <div className="h-2 w-16 rounded-full" style={{ backgroundColor: neon }} />
        <div className="h-2 w-8 opacity-40 rounded-full" style={{ backgroundColor: neon }} />
      </div>

      {/* Graphics */}
      <div className="relative mx-auto w-72 h-72 flex items-center justify-center">
        <div className="absolute inset-0 border-2 border-dashed opacity-20 rounded-full animate-[spin_20s_linear_infinite]" style={{ borderColor: neon }} />
        <div className="absolute inset-4 border-[6px] rounded-full" style={{ borderColor: neon }} />
        
        {isHeads ? (
          <div className="flex items-center justify-center">
            <div className="absolute w-32 h-32 border-2 rounded-full" style={{ borderColor: neon }} />
            <div className="absolute w-16 h-16 border-[5px] rounded-full" style={{ borderColor: neon }} />
            <div className="w-6 h-6 rounded-full" style={{ backgroundColor: neon }} />
          </div>
        ) : (
          <div className="relative w-40 h-40 flex items-center justify-center border-2 rounded-full" style={{ borderColor: neon }}>
            <svg viewBox="0 0 100 100" className="w-24 h-24" fill={neon}>
              <path d="M50 15 L90 85 L10 85 Z" />
            </svg>
          </div>
        )}
      </div>

      <h2 className="mt-10 text-[88px] font-[1000] italic leading-none text-white uppercase tracking-tighter">
        {type}
      </h2>

      <div className="mt-8 flex justify-center">
        <div className="px-6 py-2 border-2 font-mono font-black text-sm -skew-x-12" style={{ borderColor: neon, color: neon }}>
          MINORITY YIELD: +{yieldPercentage}%
        </div>
      </div>
    </button>
  );
}