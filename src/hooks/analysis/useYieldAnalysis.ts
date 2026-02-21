'use client';

import { useState, useEffect, useMemo } from 'react';

export interface YieldDataPoint {
  timestamp: number;
  value: number;
}

export interface YieldStats {
  principalStaked: number;
  netYieldAmount: number;
  currentAPY: number;
  yieldHistory: YieldDataPoint[];
  trend24h: number;
  formattedPrincipal: string;
  formattedYield: string;
  formattedAPY: string;
  formattedTrend: string;
}

const formatCurrency = (amount: number, currency: 'XLM' | 'USDC' = 'XLM'): string => {
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${currency}`;
};

const formatPercentage = (value: number): string => {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
};

const calculateTrend = (history: YieldDataPoint[]): number => {
  if (history.length < 2) return 0;

  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

  const recent = history[history.length - 1]?.value || 0;
  const past = history.find((point) => point.timestamp >= twentyFourHoursAgo)?.value || history[0]?.value || 0;

  if (past === 0) return 0;
  return ((recent - past) / past) * 100;
};

export const useYieldAnalysis = (userAddress?: string, currency: 'XLM' | 'USDC' = 'XLM') => {
  const [principalStaked, setPrincipalStaked] = useState(0);
  const [netYieldAmount, setNetYieldAmount] = useState(0);
  const [currentAPY, setCurrentAPY] = useState(0);
  const [yieldHistory, setYieldHistory] = useState<YieldDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchYieldData = async () => {
      if (!userAddress) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        // TODO: Replace with actual API call
        // const response = await fetch(`/api/yield/${userAddress}`);
        // const data = await response.json();

        // Mock data for now
        const mockData = {
          principalStaked: 10000,
          netYieldAmount: 542.5,
          currentAPY: 5.25,
          yieldHistory: Array.from({ length: 30 }, (_, i) => ({
            timestamp: Date.now() - (30 - i) * 24 * 60 * 60 * 1000,
            value: 400 + Math.random() * 150 + i * 5,
          })),
        };

        setPrincipalStaked(mockData.principalStaked);
        setNetYieldAmount(mockData.netYieldAmount);
        setCurrentAPY(mockData.currentAPY);
        setYieldHistory(mockData.yieldHistory);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch yield data');
      } finally {
        setLoading(false);
      }
    };

    fetchYieldData();
  }, [userAddress]);

  const stats: YieldStats = useMemo(() => {
    const trend24h = calculateTrend(yieldHistory);

    return {
      principalStaked,
      netYieldAmount,
      currentAPY,
      yieldHistory,
      trend24h,
      formattedPrincipal: formatCurrency(principalStaked, currency),
      formattedYield: formatCurrency(netYieldAmount, currency),
      formattedAPY: `${currentAPY.toFixed(2)}%`,
      formattedTrend: formatPercentage(trend24h),
    };
  }, [principalStaked, netYieldAmount, currentAPY, yieldHistory, currency]);

  return {
    stats,
    loading,
    error,
    formatCurrency: (amount: number) => formatCurrency(amount, currency),
    formatPercentage,
  };
};
