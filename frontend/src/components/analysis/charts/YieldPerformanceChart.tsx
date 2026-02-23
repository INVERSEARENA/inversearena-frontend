"use client";

import { motion } from "motion/react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AreaProps } from "recharts";

export type YieldDataPoint = {
  time: string;
  yield: number;
};

const defaultData: YieldDataPoint[] = [
  { time: "00:00", yield: 0.12 },
  { time: "02:00", yield: 0.18 },
  { time: "04:00", yield: 0.22 },
  { time: "06:00", yield: 0.31 },
  { time: "08:00", yield: 0.38 },
  { time: "10:00", yield: 0.45 },
  { time: "12:00", yield: 0.52 },
  { time: "14:00", yield: 0.61 },
  { time: "16:00", yield: 0.68 },
  { time: "18:00", yield: 0.74 },
  { time: "20:00", yield: 0.79 },
  { time: "22:00", yield: 0.82 },
  { time: "23:59", yield: 0.842931 },
];

type YieldPerformanceChartProps = {
  data?: YieldDataPoint[];
};

const NEON_GREEN = "#37FF1C";
const NEON_GREEN_FILL = "url(#yieldGradient)";
const LINE_STROKE = "url(#lineStrokeGradient)";

const GRID_STROKE = "rgba(55, 255, 28, 0.08)";
const AXIS_TICK = "rgba(148, 163, 184, 0.9)";

function renderDot(props: { cx?: number; cy?: number; index?: number; payload?: YieldDataPoint }, data: YieldDataPoint[]) {
  const { cx, cy, index } = props;
  if (cx == null || cy == null || index == null) return null;
  const isLast = index === data.length - 1;
  return (
    <g key={`dot-${index}`}>
      {isLast && (
        <circle
          cx={cx}
          cy={cy}
          r={10}
          fill="none"
          stroke={NEON_GREEN}
          strokeWidth={1.5}
          strokeOpacity={0.4}
          className="animate-pulse"
        />
      )}
      <circle
        cx={cx}
        cy={cy}
        r={isLast ? 5 : 3}
        fill={NEON_GREEN}
        stroke="rgba(0,0,0,0.2)"
        strokeWidth={1}
      />
    </g>
  );
}

export function YieldPerformanceChart({ data = defaultData }: YieldPerformanceChartProps) {
  const latestYield = data.length > 0 ? data[data.length - 1]?.yield : 0;

  return (
    <motion.div
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl p-5"
      style={{
        background: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(55, 255, 28, 0.15)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.03) inset",
      }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
      whileHover={{
        boxShadow: "0 8px 32px rgba(0,0,0,0.25), 0 0 20px rgba(55, 255, 28, 0.08), 0 0 0 1px rgba(255,255,255,0.03) inset",
        transition: { duration: 0.2 },
      }}
    >
      <div className="relative flex shrink-0 items-center justify-between gap-4">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#37FF1C]">
          Yield performance (24h)
        </p>
        <motion.span
          className="rounded-md bg-[#37FF1C]/10 px-2.5 py-1 font-mono text-sm font-bold tabular-nums text-[#37FF1C]"
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.15, duration: 0.35, ease: "easeOut" }}
        >
          {latestYield.toFixed(4)} <span className="font-medium text-[#37FF1C]/80">XLM</span>
        </motion.span>
      </div>

      <div className="relative mt-4 min-h-0 flex-1 w-full rounded-lg" style={{ background: "rgba(0,0,0,0.2)" }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 10, right: 28, bottom: 5, left: 5 }}
          >
            <defs>
              <linearGradient id="yieldGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={NEON_GREEN} stopOpacity={0.35} />
                <stop offset="50%" stopColor={NEON_GREEN} stopOpacity={0.08} />
                <stop offset="100%" stopColor={NEON_GREEN} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="lineStrokeGradient" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={NEON_GREEN} stopOpacity={0.5} />
                <stop offset="100%" stopColor={NEON_GREEN} />
              </linearGradient>
              <filter id="lineGlow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="2.5" result="blur" />
                <feFlood floodColor={NEON_GREEN} floodOpacity="0.5" result="color" />
                <feComposite in="color" in2="blur" operator="in" result="glow" />
                <feMerge>
                  <feMergeNode in="glow" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <CartesianGrid
              strokeDasharray="2 2"
              stroke={GRID_STROKE}
              horizontal={true}
              vertical={true}
            />
            <XAxis
              dataKey="time"
              axisLine={false}
              tick={{ fill: AXIS_TICK, fontSize: 10, fontFamily: "monospace" }}
              tickLine={false}
              interval={2}
              minTickGap={32}
            />
            <YAxis
              dataKey="yield"
              axisLine={false}
              tickLine={false}
              tick={{ fill: AXIS_TICK, fontSize: 10, fontFamily: "monospace" }}
              tickFormatter={(v) => v.toFixed(2)}
              width={32}
              tickCount={5}
              domain={["auto", "auto"]}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(15, 23, 42, 0.95)",
                border: "1px solid rgba(55, 255, 28, 0.25)",
                borderRadius: "8px",
                fontFamily: "monospace",
                fontSize: "11px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              }}
              labelStyle={{ color: "#e2e8f0", fontWeight: 600 }}
              formatter={(value: number | undefined) =>
                value != null ? [value.toFixed(6), "Yield"] : ["—", "Yield"]}
              labelFormatter={(label) => `Time: ${label}`}
              cursor={{ stroke: NEON_GREEN, strokeWidth: 1, strokeDasharray: "4 4", strokeOpacity: 0.6 }}
            />
            <Area
              type="monotone"
              dataKey="yield"
              stroke="none"
              fill={NEON_GREEN_FILL}
              isAnimationActive={true}
              animationDuration={1000}
              animationEasing="ease-out"
            />
            <Area
              type="monotone"
              dataKey="yield"
              stroke={LINE_STROKE}
              strokeWidth={2.5}
              fill="none"
              dot={(props: any) => renderDot(props, data)} activeDot={{
                r: 5,
                fill: NEON_GREEN,
                stroke: "rgba(255,255,255,0.3)",
                strokeWidth: 1,
                filter: "url(#lineGlow)",
              }}
              isAnimationActive={true}
              animationDuration={1000}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}
