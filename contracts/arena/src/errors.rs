use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ArenaError {
    /// Arena configuration not found
    ConfigNotFound = 1,
    /// Entry fee must be positive
    InvalidEntryFee = 2,
    /// Deadline must be in the future
    DeadlineTooSoon = 3,
    /// Arena has already started or finished
    ArenaAlreadyStarted = 4,
    /// Invalid state transition
    InvalidStateTransition = 5,
    /// Arena is full
    ArenaFull = 6,
    /// Join deadline has passed
    DeadlinePassed = 7,
    /// Player has been eliminated
    PlayerEliminated = 8,
    /// Prize already claimed
    PrizeAlreadyClaimed = 9,
    /// Game not finished
    GameNotFinished = 10,
    /// Not a registered player
    NotAPlayer = 11,
    /// Cooldown period between arena creations has not elapsed
    CooldownNotElapsed = 12,
    /// Treasury address has not been set
    TreasuryNotSet = 13,
    /// Contract is paused; state-mutating operations blocked
    ContractPaused = 14,
    /// Slash rate in bps cannot exceed 10000 (100%)
    InvalidSlashRate = 15,
    /// No stake available to withdraw
    NoStakeToWithdraw = 16,
    /// Stake amount must be positive
    InvalidStakeAmount = 17,
}

