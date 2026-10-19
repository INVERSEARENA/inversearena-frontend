use soroban_sdk::{Address, BytesN, contracterror, contracttype};

/// Error codes returned by the payout contract.
#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutError {
    /// The contract has not been initialised with an admin and token.
    NotInitialised = 1,
    /// `initialize` was called on an already-initialised contract.
    AlreadyInitialised = 2,
    /// Caller is not the configured admin.
    Unauthorized = 3,
    /// This `(arena, recipient)` pair has already been paid (idempotency guard).
    AlreadyPaid = 4,
    /// A payout amount was zero or negative.
    InvalidAmount = 5,
    /// A batch payout was submitted with no entries.
    EmptyBatch = 6,
    /// Contract token balance is insufficient for the payout total.
    InsufficientBalance = 8,
    /// A batch pays the same `(arena, recipient)` pair twice.
    DuplicateRecipient = 9,
    /// Batch entry count exceeds the configured maximum.
    BatchTooLarge = 10,
    /// No pending admin transfer has been proposed.
    NoPendingAdmin = 11,
    // 12 and 13 were `DestinationMismatch` / `DestinationNotRegistered` from
    // the #1450 destination binding, superseded by arena validation (#1632).
    // Left unassigned so old codes are never reused with a new meaning.
    /// The arena does not answer `get_settlement` — it is not an arena, or it
    /// runs WASM older than #1632. Upgrade the arena before paying out (#1632).
    ArenaSettlementUnavailable = 14,
    /// The factory has no record of this arena at the pool id it reports, so
    /// it was not deployed by the protocol (#1632).
    UnknownArena = 15,
    /// The arena has not finished with a single winner (#1632).
    ArenaNotSettled = 16,
    /// The recipient is not the arena's recorded winner (#1632).
    NotArenaWinner = 17,
    /// The amount exceeds the prize the arena records for its winner (#1632).
    ExceedsEntitlement = 18,
    /// Paying this would push today's outflow over the daily cap (#1632).
    DailyCapExceeded = 19,
    /// The arena's prize is denominated in a different token from the one this
    /// contract pays out (#1632).
    TokenMismatch = 20,
    /// `apply_daily_cap` was called with no cap increase pending (#1632).
    NoPendingCap = 21,
    /// The cap increase's timelock has not elapsed yet (#1632).
    CapTimelockPending = 22,
    /// A daily cap must be positive (#1632).
    InvalidCap = 23,
}

/// Mirror of `arena::types::Settlement`, decoded from the arena's
/// `get_settlement` read (#1632). A contracttype struct is encoded as a map
/// keyed by field name, so these names and types are an ABI shared with the
/// arena — keep them identical.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaSettlement {
    pub finished: bool,
    pub winner: Option<Address>,
    pub prize: i128,
    pub stake_token: Address,
    pub pool_id: u32,
}

/// Mirror of `factory::types::ArenaStatus` (variant names are the ABI).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArenaStatus {
    Pending,
    Active,
    Finished,
    Cancelled,
}

/// Mirror of `factory::types::ArenaMetadata`, decoded from the factory's
/// `get_arena` read to confirm an arena is genuine (#1632).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaMetadata {
    pub arena_address: Address,
    pub pool_id: u32,
    pub host: Address,
    pub entry_fee: i128,
    pub status: ArenaStatus,
    pub created_at: u64,
    pub metadata_hash: BytesN<32>,
}

/// A daily-cap increase waiting out its timelock (#1632).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingCap {
    pub cap: i128,
    /// Ledger timestamp from which `apply_daily_cap` may apply it.
    pub eta: u64,
}
