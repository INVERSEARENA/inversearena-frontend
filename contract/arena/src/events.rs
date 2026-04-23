use soroban_sdk::{contracttype, symbol_short, Address, String, Symbol, Vec};
use crate::state::ArenaState;

pub const TOPIC_ROUND_STARTED: Symbol = symbol_short!("R_START");
pub const TOPIC_ROUND_TIMEOUT: Symbol = symbol_short!("R_TOUT");
pub const TOPIC_ROUND_RESOLVED: Symbol = symbol_short!("RSLVD");
pub const TOPIC_CLAIM: Symbol = symbol_short!("CLAIM");
pub const TOPIC_WINNER_SET: Symbol = symbol_short!("WIN_SET");
pub const TOPIC_CANCELLED: Symbol = symbol_short!("CANCEL");
pub const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
pub const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
pub const TOPIC_LEAVE: Symbol = symbol_short!("LEAVE");
pub const TOPIC_STATE_CHANGED: Symbol = symbol_short!("ST_CHG");
pub const TOPIC_PLAYER_JOINED: Symbol = symbol_short!("P_JOIN");
pub const TOPIC_CHOICE_SUBMITTED: Symbol = symbol_short!("CH_SUB");
pub const TOPIC_PLAYER_ELIMINATED: Symbol = symbol_short!("P_ELIM");
pub const TOPIC_WINNER_DECLARED: Symbol = symbol_short!("W_DECL");
pub const TOPIC_ARENA_CANCELLED: Symbol = symbol_short!("A_CANC");
pub const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
pub const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
pub const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");

pub const EVENT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Choice {
    Heads,
    Tails,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerJoined {
    pub arena_id: u64,
    pub player: Address,
    pub entry_fee: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChoiceSubmitted {
    pub arena_id: u64,
    pub round: u32,
    pub player: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundResolved {
    pub arena_id: u64,
    pub round: u32,
    pub heads_count: u32,
    pub tails_count: u32,
    pub eliminated: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerEliminated {
    pub arena_id: u64,
    pub round: u32,
    pub player: Address,
    pub choice_made: Choice,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WinnerDeclared {
    pub arena_id: u64,
    pub winner: Address,
    pub prize_pool: i128,
    pub yield_earned: i128,
    pub total_rounds: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaCancelled {
    pub arena_id: u64,
    pub reason: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaStateChanged {
    pub old_state: ArenaState,
    pub new_state: ArenaState,
}
