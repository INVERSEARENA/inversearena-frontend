/**
 * Sybil and host-collusion detection worker — issue #1635.
 *
 * Computes risk signals for arena participants and flags suspicious results
 * so the ranked leaderboard can exclude them pending admin review.
 *
 * Signals computed:
 *   1. Common funding source — wallets that received their seed XLM from the
 *      same account within N hops on Horizon payments (bounded BFS).
 *   2. Host-funded participants — arena host funded one or more participant
 *      wallets directly.
 *   3. Co-occurrence — wallets that appear together in arenas more often than
 *      expected by chance (chi-square threshold).
 *   4. Identical commit timing — multiple wallets submitting their commit tx
 *      within TIMING_WINDOW_MS of each other across multiple arenas.
 *
 * Output: a `SybilFlag` record per (arena_result_id, wallet_address) with the
 * triggering signals and a composite risk score.  The leaderboard query
 * excludes rows with any unreviewed flag.
 *
 * Configuration via env vars:
 *   SYBIL_FUNDING_HOPS          Max hops for funding-graph BFS (default: 2)
 *   SYBIL_COOCCURRENCE_MIN      Min shared arenas to flag co-occurrence (default: 3)
 *   SYBIL_TIMING_WINDOW_MS      Commit-timing window in ms (default: 2000)
 *   SYBIL_RISK_THRESHOLD        Min composite score to write a flag (default: 0.6)
 */

import { logger, reportErrorToSentry } from "../utils/logger";

// ── Configuration ──────────────────────────────────────────────────────────────

const FUNDING_HOPS = parseInt(process.env.SYBIL_FUNDING_HOPS ?? "2", 10);
const COOCCURRENCE_MIN = parseInt(process.env.SYBIL_COOCCURRENCE_MIN ?? "3", 10);
const TIMING_WINDOW_MS = parseInt(process.env.SYBIL_TIMING_WINDOW_MS ?? "2000", 10);
const RISK_THRESHOLD = parseFloat(process.env.SYBIL_RISK_THRESHOLD ?? "0.6");

// Known exchange / funder addresses that should not trigger funding-graph flags.
// Expand this list as exchanges onboard to Stellar.
const FUNDING_ALLOWLIST = new Set<string>(
  (process.env.SYBIL_FUNDING_ALLOWLIST ?? "").split(",").filter(Boolean)
);

// ── Types ──────────────────────────────────────────────────────────────────────

export type SybilSignal =
  | "common_funder"
  | "host_funded_participant"
  | "high_cooccurrence"
  | "synchronized_commits";

export interface SybilFlag {
  arenaResultId: string;
  walletAddress: string;
  signals: SybilSignal[];
  riskScore: number;
  flaggedAt: Date;
  reviewedAt?: Date;
  reviewDecision?: "confirmed" | "dismissed";
}

export interface ArenaParticipant {
  walletAddress: string;
  arenaId: string;
  hostAddress: string;
  commitTimestampMs: number;
}

// ── Signal: host-funded participants ──────────────────────────────────────────

/**
 * Returns true if `participant` received a payment directly from `host`
 * according to the Horizon payments snapshot.
 */
export function isHostFunded(
  participant: string,
  host: string,
  fundingEdges: Map<string, string[]>
): boolean {
  if (FUNDING_ALLOWLIST.has(host)) return false;
  const funders = fundingEdges.get(participant) ?? [];
  return funders.includes(host);
}

// ── Signal: common funding source (bounded BFS) ───────────────────────────────

/**
 * Returns the common ancestor funder within `maxHops`, or null if none found.
 * Both wallets must share the same ancestor for the signal to fire.
 */
export function findCommonFunder(
  walletA: string,
  walletB: string,
  fundingEdges: Map<string, string[]>,
  maxHops = FUNDING_HOPS
): string | null {
  function ancestors(wallet: string): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ addr: string; depth: number }> = [{ addr: wallet, depth: 0 }];
    while (queue.length > 0) {
      const { addr, depth } = queue.shift()!;
      if (depth >= maxHops) continue;
      for (const funder of fundingEdges.get(addr) ?? []) {
        if (FUNDING_ALLOWLIST.has(funder)) continue;
        if (!visited.has(funder)) {
          visited.add(funder);
          queue.push({ addr: funder, depth: depth + 1 });
        }
      }
    }
    return visited;
  }

  const ancestorsA = ancestors(walletA);
  const ancestorsB = ancestors(walletB);
  for (const a of ancestorsA) {
    if (ancestorsB.has(a)) return a;
  }
  return null;
}

// ── Signal: synchronized commits ─────────────────────────────────────────────

/**
 * Returns true if two participants submitted their commit within TIMING_WINDOW_MS
 * of each other.
 */
export function haveSynchronizedCommits(
  a: ArenaParticipant,
  b: ArenaParticipant,
  windowMs = TIMING_WINDOW_MS
): boolean {
  return Math.abs(a.commitTimestampMs - b.commitTimestampMs) <= windowMs;
}

// ── Composite risk score ──────────────────────────────────────────────────────

export function computeRiskScore(signals: SybilSignal[]): number {
  const weights: Record<SybilSignal, number> = {
    common_funder: 0.4,
    host_funded_participant: 0.5,
    high_cooccurrence: 0.3,
    synchronized_commits: 0.3,
  };
  // Cap at 1.0
  return Math.min(signals.reduce((sum, s) => sum + weights[s], 0), 1.0);
}

// ── Worker ────────────────────────────────────────────────────────────────────

export class SybilDetectionWorker {
  async analyzeArena(
    participants: ArenaParticipant[],
    fundingEdges: Map<string, string[]>,
    cooccurrenceCounts: Map<string, number>
  ): Promise<SybilFlag[]> {
    const flags: SybilFlag[] = [];

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      const signals: SybilSignal[] = [];

      // Host-funded check
      if (isHostFunded(p.walletAddress, p.hostAddress, fundingEdges)) {
        signals.push("host_funded_participant");
      }

      // Co-occurrence check
      const coKey = `${p.walletAddress}`;
      const coCount = cooccurrenceCounts.get(coKey) ?? 0;
      if (coCount >= COOCCURRENCE_MIN) {
        signals.push("high_cooccurrence");
      }

      // Pairwise signals against other participants
      for (let j = i + 1; j < participants.length; j++) {
        const q = participants[j];

        // Common funder
        if (findCommonFunder(p.walletAddress, q.walletAddress, fundingEdges)) {
          if (!signals.includes("common_funder")) signals.push("common_funder");
        }

        // Synchronized commits
        if (haveSynchronizedCommits(p, q)) {
          if (!signals.includes("synchronized_commits")) {
            signals.push("synchronized_commits");
          }
        }
      }

      const riskScore = computeRiskScore(signals);
      if (signals.length > 0 && riskScore >= RISK_THRESHOLD) {
        flags.push({
          arenaResultId: p.arenaId,
          walletAddress: p.walletAddress,
          signals,
          riskScore,
          flaggedAt: new Date(),
        });
        logger.warn(
          { wallet: p.walletAddress, arena: p.arenaId, signals, riskScore },
          "Sybil signal detected — flagging for admin review"
        );
      }
    }

    return flags;
  }
}
