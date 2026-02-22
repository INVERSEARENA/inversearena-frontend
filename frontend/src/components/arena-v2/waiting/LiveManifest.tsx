"use client";

import { motion } from "framer-motion";

interface Participant {
    walletId: string;
    status: "JOINING" | "READY";
    timestamp: string;
}

interface LiveManifestProps {
    participants?: Participant[];
}

const DEFAULT_PARTICIPANTS: Participant[] = [
    { walletId: "GB7W...RQT2", status: "JOINING", timestamp: "14:22:01" },
    { walletId: "0x71...9B2A", status: "READY", timestamp: "14:21:55" },
    { walletId: "GD3L...88K1", status: "READY", timestamp: "14:21:42" },
    { walletId: "0x12...5C0D", status: "READY", timestamp: "14:20:10" },
    { walletId: "GAK9...3PX9", status: "READY", timestamp: "14:19:58" },
    { walletId: "0x88...FF21", status: "READY", timestamp: "14:18:33" },
    { walletId: "GCCN...L00P", status: "READY", timestamp: "14:17:45" },
];

export function LiveManifest({
    participants = DEFAULT_PARTICIPANTS,
}: LiveManifestProps) {
    return (
        <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="flex flex-col neubrutalist-border bg-black overflow-hidden h-full"
        >
            {/* Header */}
            <div className="p-4 neubrutalist-border border-x-0 border-t-0 bg-[#1e293b] flex justify-between items-center shrink-0">
                <h3 className="font-black text-lg tracking-widest uppercase font-display text-white">
                    MANIFEST [LIVE_FEED]
                </h3>
                <div className="flex items-center gap-2">
                    <span className="size-2 bg-primary rounded-full animate-pulse" />
                    <span className="text-xs font-bold text-primary uppercase font-display">
                        SYNCING
                    </span>
                </div>
            </div>

            {/* Scrollable table */}
            <div className="flex-1 overflow-y-auto font-mono text-sm waiting-scrollbar">
                <table className="w-full border-collapse">
                    <thead className="sticky top-0 bg-black z-10">
                        <tr className="text-left border-b-2 border-[#1e293b]">
                            <th className="p-4 text-xs font-bold text-white/40 uppercase">
                                WALLET_ID
                            </th>
                            <th className="p-4 text-xs font-bold text-white/40 uppercase">
                                STATUS
                            </th>
                            <th className="p-4 text-xs font-bold text-white/40 uppercase">
                                TIMESTAMP
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {participants.map((p, i) => (
                            <tr
                                key={`${p.walletId}-${i}`}
                                className={
                                    p.status === "JOINING"
                                        ? "joining-flash border-b border-white/10"
                                        : "border-b border-white/10 hover:bg-white/5"
                                }
                            >
                                <td className="p-4 font-bold uppercase tracking-tighter text-inherit">
                                    {p.walletId}
                                </td>
                                <td className="p-4">
                                    {p.status === "JOINING" ? (
                                        <span className="font-black italic animate-pulse">
                                            JOINING...
                                        </span>
                                    ) : (
                                        <span className="text-primary font-bold">READY</span>
                                    )}
                                </td>
                                <td
                                    className={`p-4 text-xs ${p.status === "JOINING" ? "opacity-70" : "opacity-50"
                                        }`}
                                >
                                    {p.timestamp}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </motion.div>
    );
}
