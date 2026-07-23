use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ArenaError {
    /// Arena configuration not found (contract not initialized)
    ConfigNotFound = 1,
    /// Entry fee must be positive
    InvalidEntryFee = 2,
    /// Join deadline must be in the future
    DeadlineTooSoon = 3,
    /// Arena has already started or finished
    ArenaAlreadyStarted = 4,
    /// Invalid state transition attempted
    InvalidStateTransition = 5,
    /// Arena is at max capacity
    ArenaFull = 6,
    /// Join deadline has passed
    DeadlinePassed = 7,
    /// Player has been eliminated from the game
    PlayerEliminated = 8,
    /// Prize pool has already been claimed
    PrizeAlreadyClaimed = 9,
    /// Game has not finished yet
    GameNotFinished = 10,
    /// Address is not a registered player
    NotAPlayer = 11,
    /// Player has already submitted a choice this round
    AlreadySubmitted = 12,
}
