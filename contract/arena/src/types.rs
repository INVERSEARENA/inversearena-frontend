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
    pub entry_fee: i128,
    pub state: GameState,
    /// Total number of players that have ever joined this arena. Kept in sync
    /// by `ArenaStorage::add_player` so it can be read without scanning storage.
    pub player_count: u32,
    /// Ledger timestamp (seconds) after which commitments are no longer
    /// accepted and the reveal phase begins.
    pub commit_deadline: u64,
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
    /// Commit phase has ended — the current ledger timestamp is past the
    /// configured `commit_deadline`.
    CommitPhaseEnded = 4,
    /// Reveal phase is not yet active — the commit deadline has not passed.
    RevealPhaseNotActive = 5,
    /// The computed hash of (choice | salt) does not match the stored
    /// commitment for this player.
    HashMismatch = 6,
    /// The player has already revealed their choice for this round.
    AlreadyRevealed = 7,
    /// No prior commitment was found for this player.
    NoCommitmentFound = 8,
    /// `resolve_round` was called before the round was started.
    RoundNotStarted = 9,
    /// `resolve_round` was called before the minimum grace period elapsed.
    GracePeriodNotElapsed = 10,
    /// The operation requires the arena to be in the Active state.
    RoundNotActive = 11,
}
