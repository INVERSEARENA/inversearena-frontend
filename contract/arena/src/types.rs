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
}

/// Top-level arena configuration stored in persistent storage.
#[contracttype]
#[derive(Clone)]
pub struct ArenaConfig {
    pub admin: Address,
    pub stake_token: Address,
    pub entry_fee: i128,
    pub state: GameState,
    /// Total number of players that have ever joined this arena. Kept in sync
    /// by `ArenaStorage::add_player` so it can be read without scanning storage.
    pub player_count: u32,
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
    /// Arena is already initialised.
    AlreadyInitialised = 4,
    /// A pending admin transfer already exists.
    TransferInProgress = 5,
    /// No pending admin transfer to accept or cancel.
    NoPendingTransfer = 6,
    /// Proposed new admin is the same as the current admin.
    CannotTransferToSelf = 7,
}
