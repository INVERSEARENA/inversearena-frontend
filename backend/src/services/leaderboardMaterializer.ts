export interface LeaderboardMaterializedRow {
  id: string;
  walletAddress: string;
  totalYield: number;
  arenasWon: number;
  survivalStreak: number;
  rank: number;
}

export interface LeaderboardMaterializer {
  materialize(limit: number, offset: number): Promise<LeaderboardMaterializedRow[]>;
}

/** Bounded, incremental facade used by the controller; Postgres remains the source of truth. */
export class PostgresLeaderboardMaterializer implements LeaderboardMaterializer {
  constructor(private readonly readPage: (limit: number, offset: number) => Promise<LeaderboardMaterializedRow[]>) {}

  async materialize(limit: number, offset: number): Promise<LeaderboardMaterializedRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101 || !Number.isInteger(offset) || offset < 0) {
      throw new RangeError("Invalid leaderboard materialization window");
    }
    return this.readPage(limit, offset);
  }
}
