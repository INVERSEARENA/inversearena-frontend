use soroban_sdk::{Address, BytesN, contracterror, contracttype};

/// Schema-level limits for untrusted, size-variable inputs (#1455).
///
/// Maximum number of `ArenaMetadata` records `get_arenas` returns in one
/// call, however large the caller-supplied `limit` is. Bounds the response
/// payload and the number of storage reads per invocation. Off-chain
/// consumers (backend indexer, frontend) must page with at most this size.
pub const MAX_ARENAS_PAGE_SIZE: u32 = 50;

/// Clamp a caller-supplied page size to `[0, MAX_ARENAS_PAGE_SIZE]`.
/// Clamping (not rejecting) preserves the existing read-only ABI behaviour.
pub fn clamp_page_size(limit: u32) -> u32 {
    core::cmp::min(limit, MAX_ARENAS_PAGE_SIZE)
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolConfig {
    pub stake_token: Address,
    pub yield_vault: Address,
    pub entry_fee: i128,
    pub oracle_contract: Address,
    pub min_players: u32,
    pub max_players: u32,
    pub round_duration: u64,
    /// Unix timestamp after which the lobby no longer accepts joins and may be
    /// cancelled permissionlessly via `cancel_unstarted` (#1579). Bounded by
    /// the factory relative to the creation ledger.
    pub start_deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArenaStatus {
    Pending,
    Active,
    Finished,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaMetadata {
    pub arena_address: Address,
    pub pool_id: u32,
    pub host: Address,
    pub entry_fee: i128,
    pub status: ArenaStatus,
    pub created_at: u64,
    /// SHA-256 of the canonical metadata JSON committed at creation (#1577).
    /// Lets clients verify that off-chain name/description/rules/banner match
    /// what the host published on-chain.
    pub metadata_hash: BytesN<32>,
}

#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FactoryError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidStakeAmount = 4,
    InsufficientCreatorStake = 5,
    ArenaNotFound = 6,
    StakeBelowMinimum = 7,
    HostNotWhitelisted = 8,
    WasmHashNotSet = 9,
    PoolLimitReached = 10,
    InvalidVault = 11,
    InvalidOracle = 12,
    MaxActivePoolsReached = 13,
    PoolNotFound = 14,
    ContractPaused = 15,
    UnsupportedToken = 16,
    EntryFeeTooLow = 17,
    InvalidConfig = 18,
    NoPendingAdmin = 19,
    /// Scaling `min_stake` to a token's decimals overflowed i128 (#1361).
    ArithmeticOverflow = 20,
    /// `PoolConfig.start_deadline` was outside the allowed window relative to
    /// the creation ledger (#1579).
    InvalidStartDeadline = 21,
}
