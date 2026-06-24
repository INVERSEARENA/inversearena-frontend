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
    /// Token transfer failed
    TransferFailed = 12,
    /// Insufficient token balance
    InsufficientBalance = 13,
    /// Refund already claimed
    RefundAlreadyClaimed = 14,
    /// Arena is not cancelled
    ArenaNotCancelled = 15,
    /// No stake to withdraw
    NoStakeToWithdraw = 16,
    /// Stake already deposited
    StakeAlreadyDeposited = 17,
    /// Cooldown period between arena creations has not elapsed
    CooldownNotElapsed = 18,
    /// Treasury address has not been set
    TreasuryNotSet = 19,
    /// Contract is paused; state-mutating operations blocked
    ContractPaused = 20,
}

