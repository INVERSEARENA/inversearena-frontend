import type { ReactNode } from "react";

import { Sidebar } from "@/features/navigation/components/Sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen text-white">
      <div className="mx-auto flex min-h-screen max-w-[1400px]">
        <div className="w-[320px] shrink-0">
          <Sidebar />
        </div>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

