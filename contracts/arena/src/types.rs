use soroban_sdk::{contracttype, Address, Symbol};

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
    pub token_address: Address,
    pub entry_fee: i128,
    pub max_players: u32,
    pub join_deadline: u64,
    pub state: GameState,
    pub paused: bool,
    pub player_count: u32,
    pub treasury_address: Address,
    pub last_creation_timestamp: u64,
    pub creation_cooldown_seconds: u64,
    pub max_active_pools_per_creator: u32,
    pub active_pools: u32,
    pub factory_address: Option<Address>,
    pub creator_stake: i128,
    pub slash_rate_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovedToken {
    pub address: Address,
    pub name: Symbol,
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
