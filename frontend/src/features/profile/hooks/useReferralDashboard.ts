import { useState, useEffect } from "react";

export interface ReferralStats {
  totalReferrals: number;
  activeReferrals: number;
  qualifiedReferrals: number;
  paidReferrals: number;
  totalEarnings: number;
  pendingRewards: number;
}

export interface Referral {
  id: string;
  referee: string;
  state: "pending" | "qualified" | "paid" | "revoked";
  arenaCount: number;
  totalStake: number;
  rewardAmount: number | null;
  qualifiedAt: string | null;
  paidAt: string | null;
}

export interface ReferralDashboard {
  code: string | null;
  referrals: Referral[];
  stats: ReferralStats;
}

interface UseReferralDashboardState {
  data: ReferralDashboard | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch and manage referral dashboard data
 */
export function useReferralDashboard(): UseReferralDashboardState {
  const [data, setData] = useState<ReferralDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/referrals/dashboard");

      if (!response.ok) {
        throw new Error(
          `Failed to fetch referral dashboard: ${response.statusText}`
        );
      }

      const dashboard: ReferralDashboard = await response.json();
      setData(dashboard);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  return { data, loading, error, refetch: fetchDashboard };
}

/**
 * Hook to get or create referral code
 */
export function useReferralCode() {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCode = async () => {
      try {
        const response = await fetch("/api/referrals/code");
        if (!response.ok) throw new Error("Failed to fetch code");
        const { code } = await response.json();
        setCode(code);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchCode();
  }, []);

  return { code, loading, error };
}

/**
 * Hook to apply a referral code
 */
export function useApplyReferralCode() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (code: string): Promise<boolean> => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/referrals/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          data.error || `Failed to apply code: ${response.statusText}`
        );
      }

      return true;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
      return false;
    } finally {
      setLoading(false);
    }
  };

  return { apply, loading, error };
}
