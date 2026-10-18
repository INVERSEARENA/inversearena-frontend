// Shared leaderboard formatting utilities (production-safe).
// Moved out of `data/mockLeaderboard.ts` (#1567) so production components
// no longer import the mock module. The mock file re-exports these for
// backward compatibility with existing tests.

/** Truncate a wallet/agent ID for display (e.g. "G...X4Y2"). */
export function formatAgentId(agentId: string): string {
  if (agentId.length <= 8) return agentId;
  return `${agentId.charAt(0)}...${agentId.slice(-4)}`;
}

/** Format a number as currency (e.g. "$750.00"). */
export function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
