import { z } from 'zod';
import { Money } from './money';
import { MoneySchema } from '../validation/payloadLimits';

export enum RoundState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  RESOLVED = 'RESOLVED',
  SETTLED = 'SETTLED'
}

export const PlayerChoiceSchema = z.object({
  userId: z.string().uuid(),
  choice: z.enum(['heads', 'tails']),
  stake: MoneySchema,
});

export const RoundInputSchema = z.object({
  roundId: z.string().uuid(),
  playerChoices: z.array(PlayerChoiceSchema).min(1).max(500),
  allActivePlayerIds: z.array(z.string().uuid()).min(1).max(500),
  oracleYield: z.number().finite().min(0).max(100),
  randomSeed: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  arenaContractId: z.string().regex(/^C[A-Z2-7]{55}$/, "must be a valid Stellar contract ID (C...)"),
});

export interface PlayerChoice {
  userId: string;
  choice: string;
  stake: Money;
}

export interface RoundInput {
  roundId: string;
  playerChoices: PlayerChoice[];
  allActivePlayerIds: string[];
  oracleYield: number;
  randomSeed?: string;
  arenaContractId: string;
}

export interface Payout {
  userId: string;
  amount: Money;
  /**
   * Settlement breakdown (#1407) for this payout — see
   * settlementService.computeSettlementBreakdown. principal + yieldAmount
   * always equals amount + platformFee + dust.
   */
  principal: Money;
  yieldAmount: Money;
  platformFee: Money;
  dust: Money;
}

export interface RoundResolution {
  eliminatedPlayers: string[];
  payouts: Payout[];
  poolBalances: Record<string, Money>;
}

export interface RoundMetadata {
  playerChoices: PlayerChoice[];
  oracleYield: number;
  randomSeed: string | undefined;
  resolution: RoundResolution | undefined;
}

export interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export interface RoundData {
  id: string;
  arenaId: string;
  roundNumber: number;
  state: RoundState;
  playerChoices: PlayerChoice[];
  oracleYield: number | undefined;
  randomSeed: string | undefined;
  resolution: RoundResolution | undefined;
  metadata: RoundMetadata | undefined;
  createdAt: Date;
  updatedAt: Date;
}
