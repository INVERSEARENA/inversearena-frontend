import { useEffect, useState } from "react";
import { useAuth } from "../../../hooks/useAuth";

interface ReferralStats {
  totalReferrals: number;
  activeReferrals: number;
  qualifiedReferrals: number;
  paidReferrals: number;
  totalEarnings: number;
  pendingRewards: number;
}

interface Referral {
  id: string;
  referee: string;
  state: "pending" | "qualified" | "paid" | "revoked";
  arenaCount: number;
  totalStake: number;
  rewardAmount: number | null;
  qualifiedAt: string | null;
  paidAt: string | null;
}

interface DashboardData {
  code: string | null;
  referrals: Referral[];
  stats: ReferralStats;
}

export function ReferralDashboard() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const response = await fetch("/api/referrals/dashboard");
        if (!response.ok) throw new Error("Failed to fetch dashboard");
        const data = await response.json();
        setDashboard(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      fetchDashboard();
    }
  }, [user]);

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return <div>Loading referral dashboard...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!dashboard) return <div>No referral data</div>;

  const { code, referrals, stats } = dashboard;

  return (
    <div className="referral-dashboard">
      <h2>Referral Program</h2>

      {/* Referral Code Section */}
      <div className="referral-code-section">
        <h3>Your Referral Code</h3>
        {code ? (
          <div className="code-display">
            <code>{code}</code>
            <button
              onClick={() => handleCopyCode(code)}
              className="copy-btn"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        ) : (
          <div>Generating your referral code...</div>
        )}
      </div>

      {/* Stats Section */}
      <div className="stats-grid">
        <div className="stat">
          <div className="stat-label">Total Referrals</div>
          <div className="stat-value">{stats.totalReferrals}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Active</div>
          <div className="stat-value">{stats.activeReferrals}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Qualified</div>
          <div className="stat-value">{stats.qualifiedReferrals}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Paid</div>
          <div className="stat-value">{stats.paidReferrals}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Total Earnings</div>
          <div className="stat-value">${stats.totalEarnings.toFixed(2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Pending Rewards</div>
          <div className="stat-value">${stats.pendingRewards.toFixed(2)}</div>
        </div>
      </div>

      {/* Referrals Table */}
      <div className="referrals-table-section">
        <h3>Your Referrals</h3>
        {referrals.length === 0 ? (
          <p>No referrals yet. Share your code to get started!</p>
        ) : (
          <table className="referrals-table">
            <thead>
              <tr>
                <th>Referee</th>
                <th>Status</th>
                <th>Arenas</th>
                <th>Stake</th>
                <th>Reward</th>
                <th>Qualified</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((referral) => (
                <tr key={referral.id} className={`status-${referral.state}`}>
                  <td className="wallet-address">
                    {referral.referee.substring(0, 10)}...
                  </td>
                  <td className="status-badge">{referral.state}</td>
                  <td>{referral.arenaCount}</td>
                  <td>${referral.totalStake.toFixed(2)}</td>
                  <td>
                    {referral.rewardAmount
                      ? `$${referral.rewardAmount.toFixed(2)}`
                      : "-"}
                  </td>
                  <td>
                    {referral.qualifiedAt
                      ? new Date(referral.qualifiedAt).toLocaleDateString()
                      : "-"}
                  </td>
                  <td>
                    {referral.paidAt
                      ? new Date(referral.paidAt).toLocaleDateString()
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <style jsx>{`
        .referral-dashboard {
          padding: 20px;
          max-width: 1200px;
          margin: 0 auto;
        }

        .referral-code-section {
          background: #f5f5f5;
          padding: 20px;
          border-radius: 8px;
          margin-bottom: 30px;
        }

        .code-display {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 10px;
        }

        code {
          background: #fff;
          padding: 10px 15px;
          border-radius: 4px;
          font-family: monospace;
          font-size: 16px;
          letter-spacing: 2px;
          flex: 1;
        }

        .copy-btn {
          padding: 10px 20px;
          background: #007bff;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 600;
        }

        .copy-btn:hover {
          background: #0056b3;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 15px;
          margin-bottom: 30px;
        }

        .stat {
          background: white;
          border: 1px solid #ddd;
          padding: 15px;
          border-radius: 8px;
          text-align: center;
        }

        .stat-label {
          font-size: 12px;
          color: #666;
          text-transform: uppercase;
          margin-bottom: 5px;
        }

        .stat-value {
          font-size: 24px;
          font-weight: bold;
          color: #333;
        }

        .referrals-table-section {
          margin-top: 30px;
        }

        .referrals-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 15px;
        }

        .referrals-table th {
          background: #f5f5f5;
          padding: 12px;
          text-align: left;
          font-weight: 600;
          border-bottom: 2px solid #ddd;
        }

        .referrals-table td {
          padding: 12px;
          border-bottom: 1px solid #ddd;
        }

        .referrals-table tr:hover {
          background: #f9f9f9;
        }

        .wallet-address {
          font-family: monospace;
          font-size: 14px;
        }

        .status-badge {
          display: inline-block;
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
        }

        .status-pending .status-badge {
          background: #fff3cd;
          color: #856404;
        }

        .status-qualified .status-badge {
          background: #d1ecf1;
          color: #0c5460;
        }

        .status-paid .status-badge {
          background: #d4edda;
          color: #155724;
        }

        .status-revoked .status-badge {
          background: #f8d7da;
          color: #721c24;
        }
      `}</style>
    </div>
  );
}
