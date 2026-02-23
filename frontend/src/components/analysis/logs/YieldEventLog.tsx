"use client";

import { motion } from "motion/react";

export type YieldEvent = {
  id: string;
  timestamp: string;
  earnings: string;
  status: "OK" | "PENDING" | "FAILED";
};

const defaultEvents: YieldEvent[] = [
  { id: "1", timestamp: "2025-02-21 14:32:01", earnings: "0.002341", status: "OK" },
  { id: "2", timestamp: "2025-02-21 14:28:44", earnings: "0.001892", status: "OK" },
  { id: "3", timestamp: "2025-02-21 14:25:12", earnings: "0.003102", status: "OK" },
  { id: "4", timestamp: "2025-02-21 14:21:33", earnings: "0.001556", status: "OK" },
  { id: "5", timestamp: "2025-02-21 14:18:09", earnings: "0.002778", status: "OK" },
  { id: "6", timestamp: "2025-02-21 14:14:52", earnings: "0.001234", status: "OK" },
  { id: "7", timestamp: "2025-02-21 14:11:27", earnings: "0.002667", status: "OK" },
  { id: "8", timestamp: "2025-02-21 14:08:01", earnings: "0.001901", status: "OK" },
];

type YieldEventLogProps = {
  events?: YieldEvent[];
  maxHeight?: string;
};

function StatusBadge({ status }: { status: YieldEvent["status"] }) {
  if (status === "OK") {
    return (
      <span className="inline-flex items-center border-2 border-[#37FF1C] bg-[#37FF1C] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-black">
        OK
      </span>
    );
  }
  if (status === "PENDING") {
    return (
      <span className="inline-flex items-center border-2 border-amber-400 bg-amber-400 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-black">
        PENDING
      </span>
    );
  }
  return (
    <span className="inline-flex items-center border-2 border-red-500 bg-red-500 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-black">
      FAILED
    </span>
  );
}

export function YieldEventLog({
  events = defaultEvents,
  maxHeight,
}: YieldEventLogProps) {
  return (
    <motion.div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl"
      style={{
        ...(maxHeight != null ? { maxHeight } : {}),
        background: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(55, 255, 28, 0.15)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.03) inset",
      }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.08, ease: [0.25, 0.46, 0.45, 0.94] }}
      whileHover={{
        boxShadow: "0 8px 32px rgba(0,0,0,0.25), 0 0 20px rgba(55, 255, 28, 0.08), 0 0 0 1px rgba(255,255,255,0.03) inset",
        transition: { duration: 0.2 },
      }}
    >
      <p className="shrink-0 border-b border-white/10 px-4 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#37FF1C]">
        Yield event log
      </p>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[320px] table-auto border-collapse">
          <thead className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm">
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-200">
                Timestamp
              </th>
              <th className="px-4 py-2.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-200">
                Earnings
              </th>
              <th className="px-4 py-2.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-200">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, i) => (
              <motion.tr
                key={event.id}
                className="border-b border-white/5 transition-colors hover:bg-white/5"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.12 + i * 0.03, duration: 0.25, ease: "easeOut" }}
              >
                <td className="px-4 py-2.5 font-mono text-[11px] text-slate-200">
                  {event.timestamp}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] font-semibold text-[#37FF1C]">
                  +{event.earnings}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={event.status} />
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
