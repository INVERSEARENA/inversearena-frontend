"use client";

import dynamic from "next/dynamic";
import { ReactNode } from "react";

// Dynamically import WalletProvider to avoid SSR issues with localStorage
const WalletProvider = dynamic(
    () => import("@/features/wallet/WalletProvider").then((mod) => mod.WalletProvider),
    { ssr: false }
);

export function ClientProviders({ children }: { children: ReactNode }) {
    return <WalletProvider>{children}</WalletProvider>;
}
