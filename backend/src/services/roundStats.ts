// Pure round-statistics aggregation (issue #1852). It holds no database or
// network code: a job feeds it finalised rounds one at a time and persists the
// resulting `RoundStats`, so stats are maintained incrementally with no full
// rescans. Only finalised rounds count, so nothing is exposed before a round
// closes, and cancelled arenas are left out.

export type Side = "heads" | "tails";

/** Round states after which the tally can no longer change. */
export const FINAL_ROUND_STATES = ["RESOLVED", "SETTLED"] as const;

/** One finalised round, as read from `rounds` and its resolution. */
export interface RoundOutcome {
  arenaId: string;
  roundNumber: number;
  state: string;
  /** True when the arena was cancelled; its rounds are not counted. */
  arenaCancelled?: boolean;
  /** Players who entered the round. */
  players: number;
  headsVotes: number;
  tailsVotes: number;
  /** Players still alive after the round. */
  survivors: number;
}

/** Arena size buckets (players at the start of the arena). */
export const SIZE_BUCKETS = [
  { id: "2-4", min: 2, max: 4 },
  { id: "5-9", min: 5, max: 9 },
  { id: "10-24", min: 10, max: 24 },
  { id: "25+", min: 25, max: Number.POSITIVE_INFINITY },
] as const;
export type SizeBucketId = (typeof SIZE_BUCKETS)[number]["id"];

/** Rounds below this count are flagged as a small sample. */
export const MIN_CONFIDENT_SAMPLE = 30;

export function sizeBucketOf(players: number): SizeBucketId | null {
  const bucket = SIZE_BUCKETS.find((b) => players >= b.min && players <= b.max);
  return bucket ? bucket.id : null;
}

/**
 * The minority side is the side with fewer votes. A tie has no minority, and a
 * round where nobody voted has neither a tie nor a minority.
 */
export function minoritySide(headsVotes: number, tailsVotes: number): Side | "tie" | null {
  if (headsVotes === 0 && tailsVotes === 0) return null;
  if (headsVotes === tailsVotes) return "tie";
  return headsVotes < tailsVotes ? "heads" : "tails";
}

export interface RoundCell {
  /** Rounds counted. */
  rounds: number;
  playersIn: number;
  eliminated: number;
  minorityHeads: number;
  minorityTails: number;
  ties: number;
  zeroSurvivor: number;
}

const emptyCell = (): RoundCell => ({
  rounds: 0, playersIn: 0, eliminated: 0, minorityHeads: 0, minorityTails: 0, ties: 0, zeroSurvivor: 0,
});

export interface RoundStats {
  /** Cells keyed `${sizeBucket}|${roundNumber}`; the single source of every aggregate. */
  cells: Record<string, RoundCell>;
  /** `${arenaId}:${roundNumber}` of every round already counted, so replays are no-ops. */
  seen: string[];
}

export const emptyStats = (): RoundStats => ({ cells: {}, seen: [] });

const cellKey = (bucket: SizeBucketId, roundNumber: number) => `${bucket}|${roundNumber}`;

/** Why a round was not counted, or null when it is valid and final. */
export function rejectionReason(round: RoundOutcome, arenaSize: number): string | null {
  if (!(FINAL_ROUND_STATES as readonly string[]).includes(round.state)) return "round is not finalised";
  if (round.arenaCancelled) return "arena was cancelled";
  if (!Number.isInteger(round.roundNumber) || round.roundNumber < 1) return "invalid round number";
  if (sizeBucketOf(arenaSize) === null) return "arena size out of range";
  const counts = [round.players, round.headsVotes, round.tailsVotes, round.survivors];
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) return "negative or fractional count";
  if (round.survivors > round.players) return "more survivors than players";
  if (round.headsVotes + round.tailsVotes > round.players) return "more votes than players";
  return null;
}

/**
 * Adds one finalised round. Returns new stats (the input is not mutated). A
 * round already counted, or one that is not final, valid and in an
 * un-cancelled arena, returns the stats unchanged.
 */
export function applyRound(stats: RoundStats, round: RoundOutcome, arenaSize: number): RoundStats {
  const id = `${round.arenaId}:${round.roundNumber}`;
  if (stats.seen.includes(id) || rejectionReason(round, arenaSize) !== null) return stats;
  const bucket = sizeBucketOf(arenaSize) as SizeBucketId;
  const key = cellKey(bucket, round.roundNumber);
  const cell = { ...(stats.cells[key] ?? emptyCell()) };
  const minority = minoritySide(round.headsVotes, round.tailsVotes);

  cell.rounds += 1;
  cell.playersIn += round.players;
  cell.eliminated += round.players - round.survivors;
  if (minority === "heads") cell.minorityHeads += 1;
  else if (minority === "tails") cell.minorityTails += 1;
  else if (minority === "tie") cell.ties += 1;
  if (round.survivors === 0) cell.zeroSurvivor += 1;

  return { cells: { ...stats.cells, [key]: cell }, seen: [...stats.seen, id] };
}

/** Replays many rounds in order; used by tests and by a one-off backfill. */
export function applyRounds(
  stats: RoundStats,
  rounds: readonly { round: RoundOutcome; arenaSize: number }[],
): RoundStats {
  return rounds.reduce((acc, { round, arenaSize }) => applyRound(acc, round, arenaSize), stats);
}

export interface Confidence {
  sample: number;
  /** False when `sample` is below MIN_CONFIDENT_SAMPLE; the UI shows a small-sample indicator. */
  confident: boolean;
}

export const confidenceOf = (sample: number): Confidence => ({ sample, confident: sample >= MIN_CONFIDENT_SAMPLE });

/** Wilson 95% interval for a proportion; null for an empty sample. */
export function wilsonInterval(successes: number, n: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.959964;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export interface MinorityDistribution {
  heads: number;
  tails: number;
  ties: number;
  rounds: number;
  /** Share of decided (non-tie) rounds where the minority was Heads, with a 95% interval. */
  headsShare: number | null;
  headsShareInterval: { low: number; high: number } | null;
  tieRate: number | null;
  confidence: Confidence;
}

export interface StatsFilter {
  sizeBucket?: SizeBucketId;
}

function matching(stats: RoundStats, filter: StatsFilter): [string, RoundCell][] {
  return Object.entries(stats.cells).filter(([key]) => filter.sizeBucket === undefined || key.startsWith(`${filter.sizeBucket}|`));
}

const roundNumberOf = (key: string) => Number(key.slice(key.indexOf("|") + 1));

export function minorityDistribution(stats: RoundStats, filter: StatsFilter = {}): MinorityDistribution {
  let heads = 0, tails = 0, ties = 0, rounds = 0;
  for (const [, c] of matching(stats, filter)) {
    heads += c.minorityHeads; tails += c.minorityTails; ties += c.ties; rounds += c.rounds;
  }
  const decided = heads + tails;
  return {
    heads, tails, ties, rounds,
    headsShare: decided > 0 ? heads / decided : null,
    headsShareInterval: wilsonInterval(heads, decided),
    tieRate: rounds > 0 ? ties / rounds : null,
    confidence: confidenceOf(rounds),
  };
}

export interface CurvePoint {
  roundNumber: number;
  rounds: number;
  /** Eliminated players over players entering the round, 0..1. */
  eliminationRate: number;
  confidence: Confidence;
}

/** Average elimination rate by round number. */
export function eliminationCurve(stats: RoundStats, filter: StatsFilter = {}): CurvePoint[] {
  const byRound = new Map<number, { rounds: number; playersIn: number; eliminated: number }>();
  for (const [key, c] of matching(stats, filter)) {
    const n = roundNumberOf(key);
    const acc = byRound.get(n) ?? { rounds: 0, playersIn: 0, eliminated: 0 };
    acc.rounds += c.rounds; acc.playersIn += c.playersIn; acc.eliminated += c.eliminated;
    byRound.set(n, acc);
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([roundNumber, v]) => ({
      roundNumber,
      rounds: v.rounds,
      eliminationRate: v.playersIn > 0 ? v.eliminated / v.playersIn : 0,
      confidence: confidenceOf(v.rounds),
    }));
}

export interface HeatmapCell {
  sizeBucket: SizeBucketId;
  roundNumber: number;
  rounds: number;
  /** Players surviving the round over players entering it, 0..1. */
  survivalRate: number;
  confidence: Confidence;
}

/** Survival by arena size bucket and round number, for the heatmap and its table fallback. */
export function survivalHeatmap(stats: RoundStats): HeatmapCell[] {
  const order = new Map(SIZE_BUCKETS.map((b, i) => [b.id as string, i]));
  return Object.entries(stats.cells)
    .map(([key, c]) => ({
      sizeBucket: key.slice(0, key.indexOf("|")) as SizeBucketId,
      roundNumber: roundNumberOf(key),
      rounds: c.rounds,
      survivalRate: c.playersIn > 0 ? (c.playersIn - c.eliminated) / c.playersIn : 0,
      confidence: confidenceOf(c.rounds),
    }))
    .sort((a, b) => (order.get(a.sizeBucket) ?? 0) - (order.get(b.sizeBucket) ?? 0) || a.roundNumber - b.roundNumber);
}
