type PerformanceStat = {
  label: string;
  value: string;
  trend?: string;
  highlight?: boolean;
  badge?: string;
};

const performanceStats: PerformanceStat[] = [
  {
    label: "TOTAL GAMES PLAYED",
    value: "124",
    trend: "+12%",
  },
  {
    label: "HIGHEST ROUND REACHED",
    value: "R24",
    trend: "+2%",
  },
  {
    label: "ACCUMULATED RWA YIELD",
    value: "42.50 XLM",
    badge: "STABLE",
    highlight: true,
  },
];

export function GlobalPerformanceStats() {
  return (
    <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {performanceStats.map((stat) => (
        <article
          key={stat.label}
          className={
            stat.highlight
              ? "border-[3px] border-[#37FF1C] bg-[#37FF1C] p-4"
              : "border-[3px] border-[#0F1B2D] bg-[#131D2E] p-4"
          }
        >
          <p
            className={
              stat.highlight
                ? "font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-black/70"
                : "font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#6B7487]"
            }
          >
            {stat.label}
          </p>

          <div className="mt-3 flex items-end justify-between gap-3">
            <p
              className={
                stat.highlight
                  ? "text-3xl font-bold uppercase tracking-tight text-black"
                  : "text-3xl font-semibold uppercase tracking-tight text-white"
              }
            >
              {stat.value}
            </p>

            {stat.trend ? (
              <span className="mb-1 font-mono text-[11px] font-bold uppercase text-[#37FF1C]">
                {stat.trend}
              </span>
            ) : null}

            {stat.badge ? (
              <span className="mb-1 border border-black/30 bg-black/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-black">
                {stat.badge}
              </span>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  );
}
