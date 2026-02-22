"use client";

import { useState } from "react";
import { motion } from "framer-motion";

interface LogEntry {
    tag: "SYSTEM" | "NETWORK" | "ARENA" | "ALERT";
    message: string;
}

interface PreGameIntelProps {
    logs?: LogEntry[];
}

const DEFAULT_LOGS: LogEntry[] = [
    { tag: "SYSTEM", message: "INITIALIZING HANDSHAKE WITH SOROBAN RPC..." },
    { tag: "NETWORK", message: "CONNECTION ESTABLISHED" },
    { tag: "ARENA", message: "USER_0x42...8k2 ENTERED THE ARENA (71/100)" },
    { tag: "ARENA", message: "USER_GB7W...RQT2 ENTERED THE ARENA (72/100)" },
    { tag: "ALERT", message: "RWA TREASURY YIELD UPDATED - CURRENT APY: 4.8%" },
    { tag: "SYSTEM", message: "WAITING FOR VALIDATOR SIGNATURES..." },
    { tag: "ARENA", message: "TOTAL STAKED VALUE: 36,000 XLM" },
    { tag: "SYSTEM", message: "REFRESHING LIQUIDITY POOL DATA..." },
];

function tagColor(tag: LogEntry["tag"]): string {
    switch (tag) {
        case "NETWORK":
        case "ALERT":
            return "text-primary font-bold";
        case "ARENA":
            return "text-white";
        case "SYSTEM":
        default:
            return "text-white/40";
    }
}

export function PreGameIntel({ logs = DEFAULT_LOGS }: PreGameIntelProps) {
    const [inputValue, setInputValue] = useState("");

    return (
        <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
            className="flex-1 neubrutalist-border bg-black flex flex-col overflow-hidden"
        >
            {/* Header */}
            <div className="p-4 neubrutalist-border border-x-0 border-t-0 bg-[#1e293b] shrink-0">
                <h3 className="font-black text-lg tracking-widest uppercase flex items-center gap-2 font-display text-white">
                    <span className="material-symbols-outlined text-primary">
                        terminal
                    </span>
                    PRE-GAME_INTEL
                </h3>
            </div>

            {/* Log feed */}
            <div className="flex-1 p-4 font-mono text-xs space-y-2 overflow-y-auto waiting-scrollbar">
                {logs.map((entry, i) => (
                    <p key={i} className={tagColor(entry.tag)}>
                        &gt; [{entry.tag}]: {entry.message}
                    </p>
                ))}
                {/* Blinking cursor */}
                <div className="flex items-center gap-1">
                    <span className="text-primary font-black animate-pulse">_</span>
                </div>
            </div>

            {/* Chat input */}
            <div className="p-3 neubrutalist-border border-x-0 border-b-0 bg-[#1e293b] flex gap-2 shrink-0">
                <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    className="flex-1 bg-black border-2 border-black focus:border-primary text-white font-mono text-xs uppercase p-2 outline-none"
                    placeholder="BROADCAST INTEL TO LOBBY..."
                />
                <button className="bg-primary text-black font-black px-4 neubrutalist-border text-xs uppercase neubrutalist-button">
                    SEND
                </button>
            </div>
        </motion.div>
    );
}
