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

const TelemetryPage: React.FC = () => {
  const [globalPool, setGlobalPool] = useState<GlobalPoolData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        setError(null);
      } catch (err: unknown) {
        console.error("Failed to fetch real-time crypto price:", err);
        setError("Failed to fetch Global Pool value.");
        setGlobalPool({ value: 0, symbol: "ADA" });
      }
    };

    void fetchCryptoPrice();
    const intervalId = setInterval(fetchCryptoPrice, 60000); // TODO: Move to constants if needed

    return () => clearInterval(intervalId);
  }, []);

  const handleNotifications = () => {
    console.log("Notifications clicked");
  };

  const handleSettings = () => {
    console.log("Settings clicked");
  };

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
    <div className="w-full h-auto">
      <TelemetryBar
        systemStatus={STATIC_SYSTEM_STATUS}
        serverTelemetry={STATIC_SERVER_TELEMETRY}
        globalPool={globalPool}
        onNotificationClick={handleNotifications}
        onSettingsClick={handleSettings}
      />
      <div className="p-8">
        <h1 className="text-2xl font-bold">Dashboard Content</h1>
        <p className="text-gray-400">This is the main content area below the telemetry bar.</p>
        {error && <p className="text-red-500 mt-4">Error: {error}</p>}
      </div>
    </div>
  );
};

export default TelemetryPage;

