"use client";

import dynamic from "next/dynamic";
import { ReactNode, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/shared/lib/query/queryClient";
import { NotificationProvider } from "@/components/ui/NotificationProvider";
import { ErrorBoundary } from "@/components/error-boundary";
import { MaintenanceBanner } from "@/components/maintenance/MaintenanceBanner";
import { CompatibilitySync } from "@/shared/lib/hooks/useCompatibility";

// Dynamically import WalletProvider to avoid SSR issues with localStorage
const WalletProvider = dynamic(
    () => import("@/features/wallet/components/WalletProvider").then((mod) => mod.WalletProvider),
    { ssr: false }
);

export function ClientProviders({ children }: { children: ReactNode }) {
    const [queryClient] = useState(() => createQueryClient());

    return (
        <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
                <NotificationProvider>
                    <WalletProvider>{children}</WalletProvider>
                    <MaintenanceBanner />
                    <CompatibilitySync />
                </NotificationProvider>
            </QueryClientProvider>
        </ErrorBoundary>
    );
}
