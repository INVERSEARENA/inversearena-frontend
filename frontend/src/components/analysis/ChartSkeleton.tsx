type ChartSkeletonProps = { label: string };

export function ChartSkeleton({ label }: ChartSkeletonProps) {
  return (
    <div className="flex h-full min-h-[280px] items-center justify-center rounded-xl border border-white/10 bg-slate-950/60" role="status" aria-label={label}>
      <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400">
        <span className="size-2 animate-pulse rounded-full bg-[#37FF1C]" aria-hidden="true" />
        {label}
      </div>
    </div>
  );
}
