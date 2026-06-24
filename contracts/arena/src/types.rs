use soroban_sdk::{contracttype, Address};

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

