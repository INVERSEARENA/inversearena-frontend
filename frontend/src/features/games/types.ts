export type ArenaBadge = 'STABLE' | 'WHALE' | 'BLITZ';

export interface Arena {
    id: string;
    number: string;
    badge?: ArenaBadge;
    playersJoined: number;
    maxPlayers: number;
    roundSpeed: string;
    stake: string;
    poolYield: string;
    status: 'ACTIVE' | 'PENDING' | 'CLOSED';
    isFeatured?: boolean;
}
