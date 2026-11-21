// Admin dashboard page - lightweight route file

"use client";

import React, { useState } from "react";
import {
  MetricsOverview,
  ArenaManagementPanel,
  SystemHealthPanel,
  AdminTabs,
  useAdminMetrics,
  useArenaManagement,
  useSystemHealth,
  type AdminTab,
} from "@/features/admin";

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const { metrics, isLoading: metricsLoading } = useAdminMetrics();
  const { arenas, updateArena, isLoading: arenasLoading } = useArenaManagement();
  const { health, isLoading: healthLoading } = useSystemHealth();

  if (metricsLoading || healthLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg">Loading admin dashboard...</div>
      </div>
    );
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case "overview":
        return (
          <div className="space-y-6">
            {metrics && <MetricsOverview metrics={metrics} />}
            {health && <SystemHealthPanel health={health} />}
          </div>
        );
      case "arenas":
        return (
          <ArenaManagementPanel
            arenas={arenas}
            onUpdateArena={updateArena}
          />
        );
      case "users":
        return <div className="text-center py-12">Users management coming soon</div>;
      case "transactions":
        return <div className="text-center py-12">Transactions view coming soon</div>;
      case "governance":
        return <div className="text-center py-12">Governance panel coming soon</div>;
      case "moderation":
        return <div className="text-center py-12">Moderation tools coming soon</div>;
      case "system":
        return health ? <SystemHealthPanel health={health} /> : null;
      default:
        return null;
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          Admin Dashboard
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Manage arenas, users, and platform settings
        </p>
      </div>

      <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="mt-6">{renderTabContent()}</div>
    </div>
  );
}
