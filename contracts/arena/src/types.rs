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

