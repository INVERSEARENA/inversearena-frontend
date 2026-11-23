// Host reputation model — #1728
// Score formula v1: weighted average of completion_rate (40%), start_delay_score (25%),
// dispute_rate_inverse (20%), keeper_takeover_penalty (15%).
// Requires MIN_SAMPLE_SIZE arenas before a score is shown.

export const HOST_REPUTATION_VERSION = "1.0.0";
export const MIN_SAMPLE_SIZE = 5;

export type ReputationTier = "elite" | "trusted" | "new" | "cautious" | "unknown";

export interface HostReputationBreakdown {
  completionRate: number;    // 0–1
  cancellationRate: number;  // 0–1
  avgStartDelaySeconds: number;
  keeperTakeovers: number;
  disputeCount: number;
  arenasHosted: number;
}

export interface HostReputation {
  hostAddress: string;
  score: number | null;             // 0–100, null when below MIN_SAMPLE_SIZE
  tier: ReputationTier;
  breakdown: HostReputationBreakdown;
  formulaVersion: string;
  computedAt: string;               // ISO timestamp
}

export function computeReputationTier(score: number | null): ReputationTier {
  if (score === null) return "unknown";
  if (score >= 90) return "elite";
  if (score >= 70) return "trusted";
  if (score >= 50) return "new";
  return "cautious";
}

/** Pure scoring function — deterministic from breakdown, easy to unit-test. */
export function computeReputationScore(b: HostReputationBreakdown): number | null {
  if (b.arenasHosted < MIN_SAMPLE_SIZE) return null;

  const completionScore   = b.completionRate * 100;
  const startDelayScore   = Math.max(0, 100 - b.avgStartDelaySeconds / 36); // 1 h = -100
  const disputeScore      = Math.max(0, 100 - b.disputeCount / b.arenasHosted * 500);
  const keeperScore       = Math.max(0, 100 - b.keeperTakeovers / b.arenasHosted * 200);

  const raw =
    completionScore   * 0.40 +
    startDelayScore   * 0.25 +
    disputeScore      * 0.20 +
    keeperScore       * 0.15;

  return Math.round(Math.min(100, Math.max(0, raw)));
}
