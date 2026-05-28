#![allow(dead_code)]
use soroban_sdk::{Address, contracterror, contracttype};

/// Lifecycle state of an arena.
///
/// Transitions: Open → Active → Finished
///              Open → Cancelled  (admin cancel before game starts)
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum GameState {
    Open,
    Active,
    Finished,
    /// Admin cancelled before the game started; all entry fees refunded.
    Cancelled,
    /// Prize has been distributed to the winner; arena is fully resolved.
    Settled,
}

/// A player's coin-flip choice for a round.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Choice {
    Heads,
    Tails,
}

impl Choice {
    /// Returns the canonical byte representation used in the commitment hash.
    pub fn to_byte(self) -> u8 {
        match self {
            Choice::Heads => 0,
            Choice::Tails => 1,
        }
    }
}

/// Top-level arena configuration stored in persistent storage.
#[contracttype]
#[derive(Clone)]
pub struct ArenaConfig {
    pub admin: Address,
    pub stake_token: Address,
    /// Address of the yield-bearing RWA vault adapter contract.
    pub yield_vault: Address,
    pub entry_fee: i128,
    pub state: GameState,
    /// Total number of players that have ever joined this arena. Kept in sync
    /// by `ArenaStorage::add_player` so it can be read without scanning storage.
    pub player_count: u32,
    /// Ledger timestamp (seconds) after which commitments are no longer
    /// accepted and the reveal phase begins.
    pub commit_deadline: u64,
    /// Number of completed rounds so far. Incremented when a round resolves.
    pub round_count: u32,
    /// On-chain oracle contract that supplies the current USDY yield rate in
    /// basis points. Called once per `resolve_round` to snapshot the rate.
    /// If the oracle is unavailable the round defaults to 0 bps yield.
    pub oracle_contract: Address,
}

/// Wrapper for a pending admin transfer proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingAdmin {
    pub new_admin: Address,
}

/// Per-player state stored in persistent storage, keyed by the player address.
///
/// Returned (alongside the address) by `get_players` so indexers, analytics
/// tools, and the backend event processor can sync arena state without
/// replaying the `player_joined` event log.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct PlayerState {
    /// Whether the player is still in the game (not yet eliminated).
    pub active: bool,
    /// Number of rounds the player has survived so far.
    pub rounds_survived: u32,
}

/// Per-round yield snapshot stored in persistent storage, keyed by round number.
#[contracttype]
#[derive(Clone, Debug)]
pub struct YieldSnapshot {
    pub round: u32,
    pub total_deposited: i128,
    pub total_yield: i128,
}

/// Error codes returned by arena contract functions.
///
/// Must use `#[contracterror]` (not `#[contracttype]`) so the Soroban macro
/// can derive the `From<soroban_sdk::Error>` / `Into<soroban_sdk::Error>` impls
/// required by `#[contractimpl]` when the function returns `Result<_, ArenaError>`.
#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArenaError {
    /// Caller is not authorised to perform this operation.
    Unauthorized = 1,
    /// Operation requires the arena to be in Open state.
    CannotCancelStartedGame = 2,
    /// Arena configuration has not been initialised.
    NotInitialised = 3,

}
