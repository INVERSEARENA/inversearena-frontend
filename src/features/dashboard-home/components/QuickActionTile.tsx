import type { ReactNode } from "react";

interface QuickActionTileProps {
    icon: ReactNode;
    label: string;
    onClick?: () => void;
}

export function QuickActionTile({ icon, label, onClick }: QuickActionTileProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex flex-col items-center justify-center gap-3 border-3 border-[#1c2739] bg-black/40 p-5 transition-all hover:border-[#37FF1C]/30 hover:bg-black/60 focus:outline-none focus:ring-2 focus:ring-[#37FF1C]/50 focus:ring-offset-2 focus:ring-offset-[#081425]"
        >
            <div className="flex size-10 items-center justify-center text-zinc-400 transition-colors group-hover:text-[#37FF1C]">
                {icon}
            </div>
            <span className="text-xs font-bold tracking-wider text-zinc-300 transition-colors group-hover:text-white">
                {label}
            </span>
        </button>
    );
}

// Pre-defined icons for quick actions
export function PlusIcon() {
    return (
        <svg
            className="size-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4.5v15m7.5-7.5h-15"
            />
        </svg>
    );
}

export function GridIcon() {
    return (
        <svg
            className="size-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
            />
        </svg>
    );
}
