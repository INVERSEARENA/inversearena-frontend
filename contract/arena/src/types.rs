use soroban_sdk::{Address, BytesN, contracterror, contracttype};

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
    /// Emergency circuit breaker. When true, state-mutating gameplay entry
    /// points reject until the admin unpauses the arena.
    pub paused: bool,
    /// Total number of players that have ever joined this arena. Kept in sync
    /// by `ArenaStorage::add_player` so it can be read without scanning storage.
    pub player_count: u32,
    /// Cumulative yield accrued across all resolved rounds.
    pub cumulative_yield: i128,
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

/// A two-step upgrade proposal with a timelock.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub proposed_at: u64,
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

/// Per-round resolution metadata stored in persistent storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundResult {
    pub round: u32,
    pub eliminated: u32,
    pub survivors: u32,
    pub yield_snapshot: YieldSnapshot,
}

/// Per-round yield snapshot stored in persistent storage, keyed by round number.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct YieldSnapshot {
    pub round: u32,
    pub rate_bps: u32,
    pub accrued: i128,
}

/// A single entry in the on-chain leaderboard.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaderboardEntry {
    pub player: Address,
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
    /// Returned when a caller attempts to perform an operation they are not authorized to perform.
    ///
    /// Note that most standard authorization checks are handled automatically by Soroban's
    /// `require_auth` mechanism, which panics rather than returning a Rust error.
    Unauthorized = 1,

    /// Kept for on-chain backward compatibility (discriminant 2). Prefer `InvalidGameState`.
    CannotCancelStartedGame = 2,

    /// Kept for on-chain backward compatibility (discriminant 3). Prefer `NotInitialized`.
    NotInitialised = 3,

    /// Returned when a player attempts to reveal their choice before the commitment phase has ended
    /// (i.e. before the `commit_deadline` has passed), or when the admin attempts to resolve a round
    /// when the arena is not in the `Active` state.
    RoundNotActive = 4,

    /// Returned during round resolution when no round start timestamp is recorded in storage.
    RoundNotStarted = 5,

    /// Returned when trying to resolve a round before the grace period (round duration) has not yet passed.
    GracePeriodNotElapsed = 6,

    /// Returned when a player's revealed choice and salt do not match the cryptographic commitment
    /// they previously submitted.
    InvalidReveal = 7,

    /// Returned when a player attempts to reveal their choice, but they have not submitted a
    /// commitment for the current round.
    MissingCommitment = 8,

    /// Returned when a player attempts to reveal their choice, but they have already successfully
    /// revealed their choice for the current round.
    ChoiceAlreadyRevealed = 9,

    /// Returned when a caller attempts to call `initialize` on an arena contract that has
    /// already been initialized.
    AlreadyInitialized = 10,

    /// Returned when a player attempts to claim the prize, but the arena is not in the `Finished` state.
    GameNotFinished = 11,

    /// Returned when a player attempts to claim a prize they have already claimed, or when a payout
    /// has already been executed for this game.
    PrizeAlreadyClaimed = 12,

    /// Returned when an eliminated player attempts to claim the prize or perform an action reserved for
    /// surviving players.
    PlayerEliminated = 13,

    /// Returned when a caller attempts to accept the admin role, but there is no pending admin
    /// transfer proposal recorded.
    NoPendingAdmin = 14,

    /// Returned when the vault address provided during initialization is invalid (e.g. not a contract
    /// or not responding to the required interface).
    InvalidVaultAddress = 15,

    /// Returned when a state-mutating gameplay entry point is called while the contract is paused
    /// by the admin (emergency circuit breaker).
    ContractPaused = 16,

    /// Returned when the arena is in an invalid lifecycle state for the requested operation.
    ///
    /// Examples include attempting to join or cancel an arena that is already in progress/finished,
    /// or starting a round when the game is not in a valid state.
    InvalidGameState = 17,

    /// Returned when an operation is performed on an arena that has not yet been initialized.
    NotInitialized = 18,

    /// Returned when `start_round` is called with fewer than `MIN_PLAYERS_TO_START` active players.
    /// Prevents degenerate single-player or zero-player games where one player can win trivially.
    NotEnoughPlayers = 19,

    /// Returned when a banned player attempts to join a new arena.
    PlayerBanned = 20,

    /// Returned when the arena creator/admin attempts to join their own arena.
    CreatorCannotJoin = 21,

    /// Returned when a player attempts to join after the arena has reached capacity.
    ArenaFull = 22,

    /// Returned when configured player limits are invalid.
    InvalidPlayerLimits = 23,

    /// Returned when a guarded state-changing entry point is called again before
    /// its previous invocation has cleared the temporary reentrancy guard.
    ReentrantCall = 24,

    /// Returned when a player attempts to claim a refund, but they have already claimed it.
    RefundAlreadyClaimed = 25,

    /// Returned when a player attempts to claim a refund, but the arena is not in the Cancelled state.
    ArenaNotCancelled = 26,

    /// Returned when a player attempts to claim a refund or perform an action, but they are not registered.
    NotAPlayer = 27,

    /// Returned when an operation is attempted before the required deadline has passed.
    DeadlineTooSoon = 28,

    /// Returned when a player who has already joined the arena tries to join again.
    AlreadyJoined = 29,

    /// Returned when `execute_upgrade` is called before the timelock has elapsed after
    /// `propose_upgrade`.
    UpgradeTimelockPending = 30,

    /// Returned when `execute_upgrade` is called without a prior `propose_upgrade`.
    NoPendingUpgrade = 31,
}
