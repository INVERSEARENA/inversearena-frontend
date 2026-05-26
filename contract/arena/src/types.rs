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
