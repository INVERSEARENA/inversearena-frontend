/* YieldActionCard displays the RWA yield collateralization summary and action buttons */
export function YieldActionCard() {
  return (
    /* Outer card wrapper with neon green border and background, matching the design */
    <div className="border-[3px] border-[#37FF1C] bg-[#37FF1C] p-4">
      {/* Card title in bold uppercase monospace, black text on green background */}
      <h3 className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-black">
        YIELD PROTOCOL {/* Section heading for the yield protocol card */}
      </h3>

      {/* Description paragraph explaining the RWA yield collateralization mechanism */}
      <p className="mt-2 font-mono text-[9px] font-semibold uppercase leading-relaxed tracking-[0.1em] text-black/70">
        YOUR RWA YIELD IS CURRENTLY BEING COLLATERALIZED VIA STELLAR ASSET SANDBOXES. REWARDS ARE
        DISTRIBUTED EVERY 24 HOURS. {/* Informational copy about yield distribution schedule */}
      </p>

      {/* Action buttons row: RE-INVEST and WITHDRAW side by side */}
      <div className="mt-4 flex gap-2">
        {/* RE-INVEST button with black background and green text */}
        <button
          type="button" // Explicitly non-submit button
          className="flex-1 border-[2px] border-black bg-black px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#37FF1C] transition-opacity hover:opacity-90"
        >
          RE-INVEST {/* Button label for re-investing accumulated yield */}
        </button>

        {/* WITHDRAW button with white background and black text */}
        <button
          type="button" // Explicitly non-submit button
          className="flex-1 border-[2px] border-black bg-white px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black transition-opacity hover:opacity-90"
        >
          WITHDRAW {/* Button label for withdrawing accumulated yield */}
        </button>
      </div>
    </div>
  );
}