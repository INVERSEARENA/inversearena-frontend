"use client"
import React, { useState, useEffect } from 'react';
import TelemetryBar from './telemetry-bar.component';
import { SystemStatus, ServerTelemetry, GlobalPoolData } from './types/telemetry-bar.types';


const STATIC_SYSTEM_STATUS: SystemStatus = 'operational';
const STATIC_SERVER_TELEMETRY: ServerTelemetry = {
  region: 'US-EAST-1',
  latency: 24,
};

const TelemetryPage: React.FC = () => {
  const [globalPool, setGlobalPool] = useState<GlobalPoolData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCryptoPrice = async () => {
      try {
        // --- REAL-TIME ONLINE DATA ---
        // Fetching live data for Cardano (ADA) from the public CoinGecko API.
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd');

        if (!response.ok) {
          throw new Error(`CoinGecko API error! status: ${response.status}`);
        }

        const data = await response.json();
        
        if (data.cardano && data.cardano.usd) {
          // The API returns the price of 1 ADA. We'll simulate a larger "global pool" for visual effect.
          const totalPoolValue = data.cardano.usd * 1_500_000; // Example: 1.5M ADA in the pool
          setGlobalPool({
            value: totalPoolValue,
            symbol: '₳',
          });
          setError(null);
        } else {
          throw new Error('Invalid data structure from CoinGecko API');
        }
        
      } catch (e: any) {
        console.error("Failed to fetch real-time crypto price:", e);
        setError("Failed to fetch Global Pool value.");
        // Set a fallback value for the pool on error
        setGlobalPool({ value: 0, symbol: '₳' });
      }
    };

    fetchCryptoPrice(); // Initial fetch
    
    // Poll the API every 60 seconds for price updates (as per CoinGecko's free tier recommendations)
    const intervalId = setInterval(fetchCryptoPrice, 60000); 

    return () => clearInterval(intervalId); // Cleanup on unmount
  }, []);
  
  const handleNotifications = () => {
    console.log('Notifications clicked');
  };

  const handleSettings = () => {
    console.log('Settings clicked');
  };

  // Render a loading state for the global pool
  if (!globalPool) {
    return (
      <TelemetryBar
        systemStatus={STATIC_SYSTEM_STATUS}
        serverTelemetry={STATIC_SERVER_TELEMETRY}
        globalPool={{ value: 0, symbol: '₳' }}
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
