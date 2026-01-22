import type {
    ArenaCard,
    YieldData,
    IntelItem,
    GameResult,
    Announcement,
    NetworkMetrics,
} from "./types";

export const featuredArena: ArenaCard = {
    id: "arena-101",
    name: "NEO ARENA #101",
    currentPot: 50000,
    currency: "XLM",
    maxPlayers: 100,
    currentPlayers: 98,
    description: "High-stakes elimination protocol initiated. Survive the minority vote to claim the pot.",
    status: "live",
};

export const yieldGeneratorData: YieldData = {
    globalYield: 452902,
    apy: 12.5,
    sinceLastEpoch: "Since last epoch",
    rwaAllocation: 85,
};

export const globalIntelItems: IntelItem[] = [
    {
        id: "intel-1",
        type: "won",
        message: "WON 420 USDC",
        address: "0x7a...2f1",
        arenaRef: "Arena #99",
    },
    {
        id: "intel-2",
        type: "eliminated",
        message: "ELIMINATED",
        address: "0x3c...f19",
        arenaRef: "Arena #101",
        round: 3,
    },
    {
        id: "intel-3",
        type: "joined",
        message: "JOINED",
        address: "0x1d...e4",
        arenaRef: "Arena #102",
    },
];

export const recentGames: GameResult[] = [
    {
        id: "game-1",
        arenaId: "arena-98",
        arenaName: "Arena #98",
        result: "eliminated",
        round: 2,
    },
    {
        id: "game-2",
        arenaId: "arena-95",
        arenaName: "Arena #95",
        result: "won",
        prize: 1200,
        currency: "XLM",
    },
];

export const activeAnnouncement: Announcement = {
    id: "announce-1",
    title: "Protocol Upgrade",
    content: "Protocol upgrade scheduled for block #49281. Expected downtime: 0s.",
    link: "/announcements/protocol-upgrade",
};

export const networkMetrics: NetworkMetrics = {
    load: "low",
    gasPrice: 10.5,
    gasCurrency: "GWEI",
};
