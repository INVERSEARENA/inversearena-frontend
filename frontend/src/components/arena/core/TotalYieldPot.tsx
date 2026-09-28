/** Oracle freshness classification (#1512) — mirrors the backend's
 * `OracleFreshness` type (`GET /api/oracle/yield`'s additive `freshness` field). */
export type OracleFreshness = "fresh" | "warning" | "stale" | "unavailable";

interface TotalYieldPotProps {
  amount: number;
  apr: number;
  /** When omitted, the badge falls back to the pre-#1512 unconditional "ORACLE VERIFIED"
   * label — callers that haven't wired up freshness data yet see no behavior change. */
  freshness?: OracleFreshness;
  ageSeconds?: number | null;
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)}m ago`;
  return `${Math.floor(ageSeconds / 3_600)}h ago`;
}

export function TotalYieldPot({ amount, apr, freshness, ageSeconds }: TotalYieldPotProps) {
  const formatAmount = (num: number) => {
    const [whole, decimal] = num.toFixed(2).split(".");
    return { whole: Number(whole).toLocaleString(), decimal };
  };

  const { whole, decimal } = formatAmount(amount);

  // #1512: never present a stale/unavailable reading as if it were current —
  // only an explicitly "fresh" (or not-yet-classified, pre-#1512-caller)
  // reading earns the "ORACLE VERIFIED" claim.
  const isStale = freshness === "stale" || freshness === "unavailable";
  const badgeLabel =
    freshness === undefined
      ? "ORACLE VERIFIED"
      : isStale
        ? "RATE STALE"
        : freshness === "warning"
          ? "VERIFYING…"
          : "ORACLE VERIFIED";

  return (
    <div className="bg-white border border-zinc-300 p-6">
      <p className="font-pixel text-[8px] tracking-[0.2em] text-zinc-500 uppercase mb-3">
        Total RWA Yield Pot
      </p>

      <div className="flex items-baseline mb-4">
        <span className="font-pixel text-3xl md:text-4xl text-black">
          ${whole}.
        </span>
        <span className="font-pixel text-lg text-black">{decimal}</span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`px-3 py-1 font-pixel text-[8px] text-black ${isStale ? "bg-red-400" : "bg-neon-green"}`}
        >
          +{apr}% APR
        </span>
        <span
          className={`font-pixel text-[8px] tracking-wider ${isStale ? "text-red-500" : "text-zinc-400"}`}
        >
          {badgeLabel}
        </span>
        {typeof ageSeconds === "number" && (
          <span className="font-pixel text-[8px] text-zinc-400 tracking-wider">
            {formatAge(ageSeconds)}
          </span>
        )}
      </div>
    </div>
  );
}
