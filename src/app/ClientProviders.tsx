"use client";

import dynamic from "next/dynamic";
import { ReactNode } from "react";
import { NotificationProvider } from "@/components/ui/NotificationProvider";

// Dynamically import WalletProvider to avoid SSR issues with localStorage
const WalletProvider = dynamic(
    () => import("@/features/wallet/WalletProvider").then((mod) => mod.WalletProvider),
    { ssr: false }
);

export function ClientProviders({ children }: { children: ReactNode }) {
    return (
        <NotificationProvider>
            <WalletProvider>{children}</WalletProvider>
        </NotificationProvider>
    );
}
