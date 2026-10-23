use soroban_sdk::{contracterror, contracttype, Symbol};

/// Single persistent entry for aggregate staking state. Keeping reward
/// accounting beside the totals makes the hot paths perform one aggregate
/// read and one aggregate write (older deployments are migrated lazily).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Totals {
    pub staked: i128,
    pub shares: i128,
    pub reward_rate: i128,
    pub period_finish: u64,
    pub last_update: u64,
}

/// Inventory row for one *critical global* storage key (#1516).
///
/// A Soroban contract cannot read its own entry TTL at runtime (the SDK only
/// exposes TTL reads to the test host), so the contract publishes the key
/// *inventory* and the keeper derives headroom from RPC `getLedgerEntries`
/// `liveUntilLedgerSeq`. This struct therefore reports identity and presence
/// only, never remaining TTL, and never per-staker keys: enumerating
/// `DataKey::Position` on-chain would be unbounded and would leak holders.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageKeyInfo {
    /// The storage key this row describes (a `symbol_short!` constant).
    pub key: Symbol,
    /// Whether the key is currently present in persistent storage.
    pub present: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StakePosition {
    pub amount: i128,
    pub shares: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StakerStats {
    pub amount: i128,
    pub shares: i128,
    pub stake_share_bps: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StakingError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Paused = 3,
    InvalidAmount = 4,
    InsufficientShares = 5,
    ZeroShares = 6,
    BelowMinimumInitialStake = 7,
    /// No shares outstanding — division by zero prevented (#1011).
    NoSharesOutstanding = 8,
    /// No pending admin transfer has been proposed.
    NoPendingAdmin = 9,
    /// A checked arithmetic operation on total_staked, total_shares, or a
    /// position's amount/shares would overflow or underflow i128 (#1362).
    ArithmeticOverflow = 10,
}
