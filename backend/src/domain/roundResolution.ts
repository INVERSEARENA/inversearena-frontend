import type { Payout, RoundInput, RoundResolution } from '../types/round';
import { Money } from '../types/money';
import { computeSettlementBreakdown } from './settlement';

/** Pure round outcome calculation; persistence and Soroban reads stay in the service layer. */
export function buildRoundResolution(
  input: Pick<RoundInput, 'allActivePlayerIds' | 'playerChoices' | 'oracleYield'>,
  onChainActivePlayerIds: readonly string[],
  onChainWinner: string | null,
): RoundResolution {
  const active = new Set(onChainActivePlayerIds);
  const eliminatedPlayers = input.allActivePlayerIds.filter((id) => !active.has(id));
  const eliminatedSet = new Set(eliminatedPlayers);
  const poolBalances: Record<string, Money> = {};
  const firstStake = input.playerChoices[0]?.stake;
  if (!firstStake) throw new Error('Round resolution requires at least one player choice');
  const asset = firstStake.asset;
  const toAmount = (money: Money) => {
    if (money.asset.code !== asset.code || money.asset.issuer !== asset.issuer) {
      throw new Error('Round resolution cannot combine different assets');
    }
    return Number(money.atomicAmount) / 10 ** asset.decimals;
  };
  const fromAmount = (amount: number) => new Money(
    BigInt(Math.round(amount * 10 ** asset.decimals)),
    asset.code,
    asset.issuer,
  );
  for (const player of input.playerChoices) {
    poolBalances[player.userId] = eliminatedSet.has(player.userId)
      ? new Money(0n, asset.code, asset.issuer)
      : player.stake;
  }

  const payouts: Payout[] = [];
  if (onChainWinner) {
    const winnerChoice = input.playerChoices.find((player) => player.userId === onChainWinner);
    if (!winnerChoice || !active.has(onChainWinner)) {
      throw new Error('On-chain winner is not present in the active player choices');
    }
    const eliminatedStake = input.playerChoices
      .filter((player) => eliminatedSet.has(player.userId))
      .reduce((sum, player) => sum + toAmount(player.stake), 0);
    const breakdown = computeSettlementBreakdown({
      winnerStake: toAmount(winnerChoice.stake),
      eliminatedStake,
      oracleYieldPercent: input.oracleYield,
    });
    payouts.push({
      userId: onChainWinner,
      amount: fromAmount(breakdown.netPayout),
      principal: fromAmount(breakdown.principal),
      yieldAmount: fromAmount(breakdown.yieldAmount),
      platformFee: fromAmount(breakdown.platformFee),
      dust: fromAmount(breakdown.dust),
    });
  }

  return { eliminatedPlayers, payouts, poolBalances };
}
