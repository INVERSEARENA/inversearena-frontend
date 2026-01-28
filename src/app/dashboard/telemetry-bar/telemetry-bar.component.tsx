'use client';

import React from 'react';
import {
  TelemetryBarProps,
  SystemStatus,
  ServerTelemetry,
  GlobalPoolData,
} from './types/telemetry-bar.types';
import { Settings } from "lucide-react";

<Settings className="w-6 h-6" />;

// Placeholder icons - replace with actual icons from a library like react-icons or heroicons if available in the project
const BellIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-5 h-5"
    {...props}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.136 5.455 1.31m5.714 0a24.248 24.248 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
    />
  </svg>
);



const TelemetryBar: React.FC<TelemetryBarProps> = ({
  systemStatus,
  serverTelemetry,
  globalPool,
  onNotificationClick,
  onSettingsClick,
  className,
}) => {
  const getStatusClasses = (status: SystemStatus) => {
    switch (status) {
      case 'operational':
        return 'text-green-400 bg-green-900/20 ring-green-500/20';
      case 'degraded':
        return 'text-amber-400 bg-amber-900/20 ring-amber-500/20';
      case 'offline':
        return 'text-red-400 bg-red-900/20 ring-red-500/20';
      default:
        return 'text-gray-400 bg-gray-900/20 ring-gray-500/20';
    }
  };

  const getStatusDotColor = (status: SystemStatus) => {
    switch (status) {
      case 'operational':
        return 'bg-green-500';
      case 'degraded':
        return 'bg-amber-500';
      case 'offline':
        return 'bg-red-500';
      default:
        return 'bg-gray-500';
    }
  };

  const formatGlobalPool = (pool: GlobalPoolData) => {
    const formattedValue = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(pool.value);
    return `${pool.symbol || ''} ${formattedValue}`;
  };

  return (
    <header
      className={`sticky top-0 z-40 w-full backdrop-blur flex-none border-b border-inverse-800 bg-inverse-900/75 ${className}`}
    >
      <div className="mx-auto w-full max-w-screen-2xl px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Left section: System Status & Telemetry */}
        <div className="flex items-center gap-6">
          {/* System Status */}
          <div
            className={`inline-flex items-center gap-x-1.5 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${getStatusClasses(systemStatus)}`}
          >
            <div
              className={`h-1.5 w-1.5 rounded-full ${getStatusDotColor(systemStatus)}`}
            ></div>
            SYSTEM STATUS: {systemStatus.toUpperCase()}
          </div>

          {/* Server Telemetry */}
          <div className="flex items-center space-x-4 text-sm text-inverse-300">
            <span className="font-medium">REGION: {serverTelemetry.region}</span>
            <span className="font-medium">PING: {serverTelemetry.latency}ms</span>
          </div>
        </div>

        {/* Right section: Global Pool & Utility Actions */}
        <div className="flex items-center gap-6">
          {/* Global Pool */}
          <div className="text-xl font-bold text-inverse-100">
            GLOBAL POOL: {formatGlobalPool(globalPool)}
          </div>

          {/* Utility Actions */}
          <div className="flex items-center space-x-4">
            <button
              onClick={onNotificationClick}
              className="p-2 rounded-full text-inverse-300 hover:text-inverse-100 hover:bg-inverse-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-inverse-900 focus:ring-inverse-500"
              aria-label="Notifications"
            >
              <BellIcon />
            </button>
            <button
              onClick={onSettingsClick}
              className="p-2 rounded-full text-inverse-300 hover:text-inverse-100 hover:bg-inverse-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-inverse-900 focus:ring-inverse-500"
              aria-label="Settings"
            >
              <Settings className="w-6 h-6" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};

export default TelemetryBar;