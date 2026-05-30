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
}
