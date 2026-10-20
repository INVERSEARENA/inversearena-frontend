export type ArenaCommandCall =
  | { name: "join_arena" }
  | { name: "submit_commitment"; commitmentHex: string; round: number }
  | { name: "reveal_choice"; choice: "Heads" | "Tails"; saltHex: string; round: number }
  | { name: "claim" }
  | { name: "stake"; amountAtomic: string }
  | { name: "unstake"; amountAtomic: string };

export interface ArenaCommandPlan {
  actor: string;
  contractId: string;
  preconditions: Array<{
    name: "capability_supported" | "player_joined" | "arena_phase" | "commitment_available" | "winner" | "contract_configured";
    expected: string | boolean;
  }>;
  call: ArenaCommandCall;
  amounts: Array<{ asset: string; atomicUnits: string }>;
  revisions: { capabilityStore: number };
  createdAt: string;
  expiresAt: string;
}

export function createArenaCommandPlan(input: {
  actor: string;
  contractId: string;
  call: ArenaCommandCall;
  preconditions: ArenaCommandPlan["preconditions"];
  capabilityRevision: number;
  amounts?: ArenaCommandPlan["amounts"];
  createdAt?: Date;
  expiresInSeconds: number;
}): ArenaCommandPlan {
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
    throw new Error("Command plan expiry must be a positive whole number of seconds");
  }
  const createdAt = input.createdAt ?? new Date();
  return {
    actor: input.actor,
    contractId: input.contractId,
    preconditions: input.preconditions,
    call: input.call,
    amounts: input.amounts ?? [],
    revisions: { capabilityStore: input.capabilityRevision },
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + input.expiresInSeconds * 1_000).toISOString(),
  };
}
