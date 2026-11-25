// System health monitoring panel

"use client";

import React from "react";
import type { SystemHealth } from "../types";

interface SystemHealthPanelProps {
  health: SystemHealth;
}

export function SystemHealthPanel({ health }: SystemHealthPanelProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case "healthy":
        return "text-green-600 dark:text-green-400";
      case "degraded":
        return "text-yellow-600 dark:text-yellow-400";
      case "down":
        return "text-red-600 dark:text-red-400";
      default:
        return "text-gray-600 dark:text-gray-400";
    }
  };

  const getMetricColor = (value: number, threshold: number = 80) => {
    if (value >= threshold) return "text-red-600 dark:text-red-400";
    if (value >= threshold * 0.7) return "text-yellow-600 dark:text-yellow-400";
    return "text-green-600 dark:text-green-400";
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
        System Health
      </h2>
      
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Overall Status
          </span>
          <span className={`text-sm font-semibold uppercase ${getStatusColor(health.status)}`}>
            {health.status}
          </span>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              CPU Usage
            </span>
            <span className={`text-sm font-semibold ${getMetricColor(health.cpu)}`}>
              {health.cpu}%
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full ${
                health.cpu >= 80
                  ? "bg-red-600"
                  : health.cpu >= 56
                  ? "bg-yellow-600"
                  : "bg-green-600"
              }`}
              style={{ width: `${health.cpu}%` }}
            />
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Memory Usage
            </span>
            <span className={`text-sm font-semibold ${getMetricColor(health.memory)}`}>
              {health.memory}%
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full ${
                health.memory >= 80
                  ? "bg-red-600"
                  : health.memory >= 56
                  ? "bg-yellow-600"
                  : "bg-green-600"
              }`}
              style={{ width: `${health.memory}%` }}
            />
          </div>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Network
          </span>
          <span
            className={`text-sm font-semibold ${
              health.network === "stable"
                ? "text-green-600 dark:text-green-400"
                : "text-yellow-600 dark:text-yellow-400"
            }`}
          >
            {health.network}
          </span>
        </div>

        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Last checked: {new Date(health.lastChecked).toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}
