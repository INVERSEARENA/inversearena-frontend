import type { ReactNode } from "react";

import { Sidebar } from "@/features/navigation/components/Sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen text-white">
      <div className="fixed inset-y-0 left-0 w-[320px] overflow-y-auto">
          <Sidebar />
      </div>

    
      <div className="min-h-screen pl-[320px]">
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}

