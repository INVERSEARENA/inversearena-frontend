"use client";

import React, { useState, useEffect } from "react";
import TelemetryBar from "./telemetry-bar.component";
import {
  SystemStatus,
  ServerTelemetry,
  GlobalPoolData,
} from "./types/telemetry-bar.types";
import { CoinGeckoSimplePriceSchema } from "@/shared-d/utils/security-validation";
import { UI_BEHAVIOR } from "@/components/hook-d/arenaConstants";

const STATIC_SYSTEM_STATUS: SystemStatus = "operational";
const STATIC_SERVER_TELEMETRY: ServerTelemetry = {
  region: "US-EAST-1",
  latency: 24,
};

const COINGECKO_SIMPLE_PRICE_URL =
  process.env.NEXT_PUBLIC_COINGECKO_SIMPLE_PRICE_URL ||
  "https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd";

/**
 * The live status/global-pool bar, reusable anywhere (e.g. pinned to the top
 * of the dashboard home page). `TelemetryBar` already renders itself with
 * `sticky top-0`; this component just owns the data fetching.
 */
export const GlobalTelemetryBar: React.FC = () => {
  const [globalPool, setGlobalPool] = useState<GlobalPoolData | null>(null);

  useEffect(() => {
    const fetchCryptoPrice = async () => {
      try {
        const response = await fetch(COINGECKO_SIMPLE_PRICE_URL, {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`CoinGecko API error! status: ${response.status}`);
        }

        const rawData: unknown = await response.json();
        const data = CoinGeckoSimplePriceSchema.parse(rawData);

        const totalPoolValue = data.cardano.usd * 1_500_000;
        setGlobalPool({
          value: totalPoolValue,
          symbol: "ADA",
        });
      } catch (err: unknown) {
        console.error("Failed to fetch real-time crypto price:", err);
        setGlobalPool({ value: 0, symbol: "ADA" });
      }
    };

    void fetchCryptoPrice();
    const intervalId = setInterval(fetchCryptoPrice, UI_BEHAVIOR.TELEMETRY_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, []);

  if (!globalPool) {
    return (
      <TelemetryBar
        systemStatus={STATIC_SYSTEM_STATUS}
        serverTelemetry={STATIC_SERVER_TELEMETRY}
        globalPool={{ value: 0, symbol: "ADA" }}
        className="animate-pulse"
      />
    );
  }

  return (
    <TelemetryBar
      systemStatus={STATIC_SYSTEM_STATUS}
      serverTelemetry={STATIC_SERVER_TELEMETRY}
      globalPool={globalPool}
    />
  );
};

const TelemetryPage: React.FC = () => {
  return (
    <div className="w-full h-auto">
      <GlobalTelemetryBar />
      <div className="p-8">
        <h1 className="text-2xl font-bold">Dashboard Content</h1>
        <p className="text-gray-400">This is the main content area below the telemetry bar.</p>
      </div>
    </div>
  );
};

export default TelemetryPage;

