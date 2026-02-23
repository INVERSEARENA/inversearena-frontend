export enum RoundState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  RESOLVED = 'RESOLVED',
  SETTLED = 'SETTLED'
}

export interface PlayerChoice {
  userId: string;
  choice: string;
  stake: number;
}

export interface RoundInput {
  roundId: string;
  playerChoices: PlayerChoice[];
  oracleYield: number;
  randomSeed?: string;
}

export interface Payout {
  userId: string;
  amount: number;
}

export interface RoundResolution {
  eliminatedPlayers: string[];
  payouts: Payout[];
  poolBalances: Record<string, number>;
}

export interface RoundData {
  id: string;
  arenaId: string;
  roundNumber: number;
  state: RoundState;
  playerChoices: PlayerChoice[];
  oracleYield?: number;
  randomSeed?: string;
  resolution?: RoundResolution;
  createdAt: Date;
  updatedAt: Date;
}
