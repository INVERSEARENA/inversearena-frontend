"use client";

const TICKER_ITEMS = [
  { text: "NET CONNECTED", color: "text-neon-green" },
  { text: "YIELD HARVESTING: RWA TREASURY BILLS", color: "text-white/60" },
  { text: "HIGH VOLTAGE ARENA: PLAY AT YOUR OWN RISK", color: "text-neon-pink" },
  { text: "STELLAR/SOROBAN NETWORK VERIFIED", color: "text-neon-green" },
  { text: "ROUND IN PROGRESS", color: "text-white/60" },
];

export function ArenaFooter() {
  const repeated = [...TICKER_ITEMS, ...TICKER_ITEMS];

  return (
    <div className="w-full bg-black border border-white/10 overflow-hidden py-2">
      <div className="flex animate-[ticker_20s_linear_infinite] whitespace-nowrap w-max">
        {repeated.map((item, i) => (
          <span key={i} className={`font-pixel text-[10px] tracking-[0.2em] uppercase mx-6 ${item.color}`}>
            {item.text}
          </span>
        ))}
      </div>
    </div>
  );
}
