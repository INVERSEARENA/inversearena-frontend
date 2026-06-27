use soroban_sdk::{contracttype, Address, String};

/// Aggregated global statistics stored in contract instance storage.
/// Updated on join, round resolution, and prize claim to avoid O(n) scans.
#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct GlobalStats {
    /// Total arenas ever initialized.
    pub total_arenas: u32,
    /// Players currently alive across all in-progress arenas.
    pub live_survivors: u32,
    /// Total prize pool ever accumulated across all arenas (in stroops).
    pub global_pool_total: i128,
}

/// Snapshot of a pending RWA yield integration request.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RwaYieldRecord {
    /// Unique record identifier (monotonic counter).
    pub id: u64,
    /// The external RWA adapter contract address.
    pub adapter: Address,
    /// Amount of yield deposited into the prize pool (in stroops).
    pub yield_amount: i128,
    /// Ledger sequence at which the yield was received.
    pub received_at: u32,
    /// Human-readable source description (e.g. "Treasury vault A").
    pub source_label: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GameState {
    Open,
    InProgress,
    Finished,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ArenaConfig {
    pub admin: Address,
    pub token: Address,
    pub entry_fee: i128,
    pub max_players: u32,
    pub join_deadline: u64,
    pub state: GameState,
    pub paused: bool,
    pub player_count: u32,
    pub treasury_address: Address,
    pub last_creation_timestamp: u64,
    pub creation_cooldown_seconds: u64,
    /// Amount of stake the creator has deposited (in stroops).
    /// Tracked in contract state; actual token transfers are performed by the caller.
    pub creator_stake: i128,
    /// Slash rate in basis points (1 bps = 0.01%).
    /// Applied to `creator_stake` when the creator withdraws while active pools exist.
    /// E.g. 5000 bps = 50% slash. Maximum allowed value is 10_000 (100%).
    pub slash_rate_bps: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Choice {
    Heads,
    Tails,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundResult {
    pub round: u32,
    pub eliminated: u32,
    pub survivors: u32,
}

#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct PlayerProfile {
    pub games_played: u32,
    pub games_won: u32,
    pub total_earnings: i128,
    pub survival_streak: u32,
    pub best_streak: u32,
}

