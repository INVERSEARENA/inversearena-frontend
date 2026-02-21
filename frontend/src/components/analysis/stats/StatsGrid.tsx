type StatCard = {
  id: string;
  title: string;
  value: string;
  subtitle?: string;
  dark?: boolean;
  badge?: string;
};

const stats: StatCard[] = [
  {
    id: "principal",
    title: "PRINCIPAL STAKED",
    value: "45,000 XLM",
    subtitle: "1,200 USDC",
  },
  {
    id: "yield",
    title: "NET YIELD GENERATED",
    value: "0.842931 XLM",
    subtitle: "+0.542% (24H)",
    dark: true,
  },
  {
    id: "apy",
    title: "CURRENT APY",
    value: "12.5%",
    badge: "FIXED MULTIPLIER X1.2",
  },
];

export function StatsGrid() {
  return (
    <section className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3 md:p-6">
      {stats.map((stat) => (
        <article
          key={stat.id}
          className={
            stat.dark
              ? "border-[3px] border-black bg-black p-4"
              : "border-[3px] border-black bg-[#F5F5F5] p-4"
          }
        >
          <p
            className={
              stat.dark
                ? "font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#37FF1C]"
                : "font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#7A808A]"
            }
          >
            {stat.title}
          </p>

          <p
            className={
              stat.dark
                ? "mt-3 text-4xl font-black uppercase leading-none tracking-tight text-[#37FF1C]"
                : "mt-3 text-5xl font-bold italic leading-none tracking-tight text-[#1E2430]"
            }
          >
            {stat.value}
          </p>

          <div className="mt-3 flex items-end justify-between gap-3">
            {stat.subtitle ? (
              <p
                className={
                  stat.dark
                    ? "font-mono text-[11px] font-bold uppercase text-[#37FF1C]"
                    : "font-display text-2xl font-semibold text-[#1E2430]"
                }
              >
                {stat.subtitle}
              </p>
            ) : (
              <span />
            )}

            {stat.badge ? (
              <span className="border-2 border-black bg-white px-2 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.1em] text-black">
                {stat.badge}
              </span>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  );
}
