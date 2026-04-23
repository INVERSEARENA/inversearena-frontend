use soroban_sdk::{contracttype, Address, Env, String, Symbol, Vec, symbol_short};
use crate::errors::ArenaError;

pub const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
pub const TOKEN_KEY: Symbol = symbol_short!("TOKEN");
pub const CAPACITY_KEY: Symbol = symbol_short!("CAPACITY");
pub const PRIZE_POOL_KEY: Symbol = symbol_short!("POOL");
pub const SURVIVOR_COUNT_KEY: Symbol = symbol_short!("S_COUNT");
pub const CANCELLED_KEY: Symbol = symbol_short!("CANCEL");
pub const GAME_FINISHED_KEY: Symbol = symbol_short!("FINISHED");
pub const WINNER_SET_KEY: Symbol = symbol_short!("WIN_SET");
pub const PAUSED_KEY: Symbol = symbol_short!("PAUSED");

pub const GAME_TTL_THRESHOLD: u32 = 518400;
pub const GAME_TTL_EXTEND_TO: u32 = 1036800;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaConfig {
    pub round_speed_in_ledgers: u32,
    pub round_duration_seconds: u64,
    pub required_stake_amount: i128,
    pub max_rounds: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundState {
    pub round_number: u32,
    pub round_start_ledger: u32,
    pub round_deadline_ledger: u32,
    pub round_start: u64,
    pub round_deadline: u64,
    pub active: bool,
    pub total_submissions: u32,
    pub timed_out: bool,
    pub finished: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArenaState {
    Pending,
    Active,
    Completed,
    Cancelled,
}

impl ArenaState {
    pub fn is_terminal_state(&self) -> bool {
        matches!(self, ArenaState::Completed | ArenaState::Cancelled)
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaStateView {
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub round_number: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStateView {
    pub is_active: bool,
    pub has_won: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FullStateView {
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub round_number: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
    pub is_active: bool,
    pub has_won: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaMetadata {
    pub arena_id: u64,
    pub name: String,
    pub description: Option<String>,
    pub host: Address,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaSnapshot {
    pub arena_id: u64,
    pub state: ArenaState,
    pub current_round: u32,
    pub round_deadline: u64,
    pub total_players: u32,
    pub survivors: Vec<Address>,
    pub eliminated: Vec<Address>,
    pub prize_pool: i128,
    pub yield_earned: i128,
    pub winner: Option<Address>,
    pub config: ArenaConfig,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Round,
    RoundChoices(u32),
    Commitment(u32, Address),
    Survivor(Address),
    Eliminated(Address),
    PrizeClaimed(Address),
    Winner(Address),
    AllPlayers,
    Refunded(Address),
    State,
    Metadata(u64),
    ContractAdmin,
    FactoryAddress,
    ArenaId,
    YieldEarned,
    UpgradeHash,
    UpgradeTimestamp,
}

pub fn get_state(env: &Env) -> ArenaState {
    env.storage().instance().get(&DataKey::State).unwrap_or(ArenaState::Pending)
}

pub fn set_state(env: &Env, new_state: ArenaState) {
    use soroban_sdk::IntoVal;
    let old_state = get_state(env);
    if old_state == new_state { return; }
    env.storage().instance().set(&DataKey::State, &new_state);

    if let (Some(factory), Some(arena_id)) = (
        env.storage().instance().get::<_, Address>(&DataKey::FactoryAddress),
        env.storage().instance().get::<_, u64>(&DataKey::ArenaId)
    ) {
        env.invoke_contract::<()>(
            &factory,
            &Symbol::new(env, "update_arena_status"),
            soroban_sdk::vec![env, arena_id.into_val(env), new_state.into_val(env)],
        );
    }
}

pub fn get_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
    env.storage().instance().get(&DataKey::Config).ok_or(ArenaError::NotInitialized)
}

pub fn get_round(env: &Env) -> Result<RoundState, ArenaError> {
    env.storage().instance().get(&DataKey::Round).ok_or(ArenaError::NotInitialized)
}

pub fn bump(env: &Env, key: &DataKey) {
    match key {
        DataKey::Survivor(_) | DataKey::Eliminated(_) | DataKey::Commitment(_, _) | 
        DataKey::RoundChoices(_) | DataKey::Metadata(_) | DataKey::PrizeClaimed(_) |
        DataKey::Winner(_) | DataKey::Refunded(_) | DataKey::AllPlayers => {
            env.storage().persistent().extend_ttl(key, GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        }
        _ => {
            env.storage().instance().extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        }
    }
}

pub fn require_not_paused(env: &Env) -> Result<(), ArenaError> {
    if env.storage().instance().get::<_, bool>(&PAUSED_KEY).unwrap_or(false) {
        return Err(ArenaError::Paused);
    }
    Ok(())
}

#[macro_export]
macro_rules! assert_state {
    ($current:expr, $expected:pat) => {
        match $current {
            $expected => {},
            _ => panic!("Invalid state transition: current state {:?} is not allowed for this operation", $current),
        }
    };
}
