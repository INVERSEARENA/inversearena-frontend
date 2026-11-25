// Admin metrics overview panel

"use client";

import React from "react";
import type { AdminMetrics } from "../types";

interface MetricsOverviewProps {
  metrics: AdminMetrics;
}

export function MetricsOverview({ metrics }: MetricsOverviewProps) {
  const metricCards = [
    {
      label: "Total Arenas",
      value: metrics.totalArenas,
      subValue: `${metrics.activeArenas} active`,
    },
    {
      label: "Total Players",
      value: metrics.totalPlayers,
      subValue: `${metrics.activePlayers} active`,
    },
    {
      label: "Platform Volume",
      value: `$${(metrics.totalVolume / 1_000_000).toFixed(2)}M`,
    },
    {
      label: "Platform Fees",
      value: `$${(metrics.platformFees / 1_000).toFixed(1)}K`,
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {metricCards.map((card, index) => (
        <div
          key={index}
          className="bg-white dark:bg-gray-800 rounded-lg shadow p-6"
        >
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
            {card.label}
          </h3>
          <p className="mt-2 text-3xl font-semibold text-gray-900 dark:text-white">
            {card.value}
          </p>
          {card.subValue && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {card.subValue}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
