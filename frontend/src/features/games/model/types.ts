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
    /** Result of verifying off-chain metadata against the on-chain hash (#1577). */
    metadataVerified?: boolean | null;
}
