export type ArenaParticipant = {
  id: string;
  arenaId: string;
  userId: string;
  displayName: string;
  createdAt: string;
};

export type PoolEliminationLog = {
  id: string;
  poolId: string;
  participantId: string;
  round: number;
  reason: "majority_vote" | "timeout";
  createdAt: string;
};

function generateParticipants(arenaId: string, count: number): ArenaParticipant[] {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    return {
      id: `participant-${String(sequence).padStart(3, "0")}`,
      arenaId,
      userId: `user-${String(sequence).padStart(3, "0")}`,
      displayName: `Player ${sequence}`,
      createdAt: new Date(start + sequence * 60_000).toISOString(),
    };
  });
}

function generateEliminations(poolId: string, count: number): PoolEliminationLog[] {
  const start = Date.UTC(2026, 0, 2, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    return {
      id: `elimination-${String(sequence).padStart(3, "0")}`,
      poolId,
      participantId: `participant-${String(sequence).padStart(3, "0")}`,
      round: Math.ceil(sequence / 3),
      reason: sequence % 5 === 0 ? "timeout" : "majority_vote",
      createdAt: new Date(start + sequence * 90_000).toISOString(),
    };
  });
}

const arenaParticipants: Record<string, ArenaParticipant[]> = {
  "arena-1": generateParticipants("arena-1", 64),
  "arena-2": generateParticipants("arena-2", 17),
};

const poolEliminations: Record<string, PoolEliminationLog[]> = {
  "pool-1": generateEliminations("pool-1", 51),
  "pool-2": generateEliminations("pool-2", 9),
};

export function listParticipantsByArenaId(arenaId: string): ArenaParticipant[] {
  return arenaParticipants[arenaId] ?? [];
}

export function listEliminationsByPoolId(poolId: string): PoolEliminationLog[] {
  return poolEliminations[poolId] ?? [];
}
