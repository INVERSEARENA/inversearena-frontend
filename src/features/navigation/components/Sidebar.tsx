"use client";

import { dashboardNavItems } from "../navItems";
import { SidebarNavLink } from "./SidebarNavLink";
import { useWallet } from "@/features/wallet/useWallet";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";

import type { ReactNode } from "react";

export function Sidebar() {
  const { status, publicKey } = useWallet();

  const shortenAddress = (addr: string) =>
    addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "";
  const icons: Record<string, ReactNode> = {
    "/dashboard": (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
    "/dashboard/leaderboard": (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
    "/dashboard/profile": (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
    "/dashboard/games": (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M6 12h4m-2-2v4" />
        <line x1="15" y1="11" x2="15.01" y2="11" />
        <line x1="18" y1="13" x2="18.01" y2="13" />
      </svg>
    ),
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-white/10 bg-black">
      <div className="border-b border-white/10 px-6 py-6">
        <div className="text-lg font-bold leading-none tracking-tight text-white">
          INVERSE <span className="text-[#39ff14]">ARENA</span>
        </div>
        <div className="mt-2 text-xs font-semibold tracking-widest text-zinc-400">
          PROTOCOL
          PROTOCOL V.2.0.4
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-2 px-3 py-4">
        {dashboardNavItems.map((item) => (
          <SidebarNavLink key={item.href} {...item} icon={icons[item.href]} />
        ))}
      </nav>

      <div className="border-t border-white/10 p-4">
        {status === 'connected' ? (
          <>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#39ff14]">
              <span className="inline-block h-2 w-2 rounded-full bg-[#39ff14]" />
              WALLET CONNECTED
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-white/10 bg-white/5 px-3 py-2">
              <div className="truncate text-sm font-semibold text-zinc-200">
                {shortenAddress(publicKey!)}
              </div>
            </div>
            <div className="mt-3">
              <ConnectWalletButton />
            </div>
          </>
        ) : (
          <>
            <div className="text-xs font-semibold text-zinc-400">
              Not connected
            </div>
            <div className="mt-3">
              <ConnectWalletButton />
            </div>
          </>
        )}
        <div className="flex items-center gap-2 text-xs font-semibold text-[#39ff14]">
          <span className="inline-block size-2 rounded-full bg-[#39ff14]" />
          WALLET CONNECTED
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-white/10 bg-white/5 px-3 py-2">
          <div className="truncate text-sm font-semibold text-zinc-200">
            0x71...8A92
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
            aria-label="Open wallet"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
