use soroban_sdk::{Address, BytesN, Symbol, contracterror, contracttype};

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

/// The vault settings `create_pool` checks a pool against (#1634).
///
/// Decoded from the RWA adapter's `config()` read. It mirrors
/// `rwa_adapter::VaultConfig` field for field — a contracttype struct is
/// encoded as a map keyed by field name, so the two must keep the same names
/// and types. It is duplicated rather than imported for the same link-time
/// reason as `ArenaClient` in `lib.rs`.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultConfig {
    pub stake_token: Address,
    pub oracle: Address,
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

/// Lifecycle state of a registry entry (#1688).
///
/// Approval used to be binary: an approved token, vault or oracle was either
/// usable or not. A deprecation lifecycle separates the three states that
/// actually matter for an integration that already backs live arenas.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryState {
    /// Usable for new arenas and fully supported for the ones already live.
    Active,
    /// No longer accepted for new arenas, but still readable and settleable
    /// for the arenas that already use it.
    Deprecated,
    /// Not usable at all. Only reachable once every indexed and on-chain
    /// liability against the integration is settled.
    Disabled,
}

/// Lifecycle metadata of one registry entry (#1688).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryEntry {
    /// The state the entry is in.
    pub state: RegistryState,
    /// Ledger timestamp at which the state took effect. `0` for an entry
    /// that predates the lifecycle (an unknown legacy entry), which is
    /// treated as `Active`.
    pub effective_ledger: u64,
    /// Machine-readable reason for the transition, e.g. `migrated` or
    /// `issuer_sunset`.
    pub reason: Symbol,
}

/// Which registry an entry belongs to (#1688).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryKind {
    /// Supported stake tokens.
    Token,
    /// Approved yield vaults.
    Vault,
    /// Approved oracles.
    Oracle,
}

/// The integrations a pool was created with (#1688).
///
/// Recorded per pool so the factory can tell which entries still carry
/// liabilities, and so a deprecation can be checked against the pools that
/// were created before it.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolIntegration {
    pub stake_token: Address,
    pub yield_vault: Address,
    pub oracle_contract: Address,
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
    /// The vault's stake token differs from `PoolConfig.stake_token`, or from
    /// the token the vault was approved with — e.g. the vault was upgraded to
    /// a different asset after approval (#1634).
    VaultTokenMismatch = 22,
    /// `PoolConfig.oracle_contract` is not the oracle the vault accrues yield
    /// from, so the arena's yield snapshots would disagree with what the
    /// vault actually pays (#1634).
    OracleMismatch = 23,
    /// The registry entry exists but is deprecated or disabled, so it is not
    /// accepted for a new arena (#1688). Existing arenas that already use it
    /// are unaffected.
    DeprecatedIntegration = 24,
    /// The integration still carries liabilities — indexed pools that are
    /// still live, or pools created before the registry tracked them — so it
    /// cannot be disabled yet (#1688). The emergency removal path
    /// (`remove_approved_vault` and friends) is unaffected by this guard.
    OutstandingLiabilities = 25,
    /// The entry is not approved, so it cannot be reactivated (#1688).
    IntegrationNotApproved = 26,
}
