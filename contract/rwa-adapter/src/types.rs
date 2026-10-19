use soroban_sdk::{Address, contracterror, contracttype};

/// Wrapper for a pending admin transfer proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingAdmin {
    pub new_admin: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct RwaConfig {
    pub admin: Address,
    pub stake_token: Address,
    pub oracle: Address,
    pub total_deposited: i128,
}

/// Public, read-only view of the settings a vault was initialised with
/// (#1634). Returned by `RwaAdapter::config` so the factory can check that an
/// arena's `stake_token` and `oracle_contract` match the vault it is wired to.
///
/// The factory decodes this with its own copy of the struct
/// (`factory::types::VaultConfig`), so the field names and types here are an
/// ABI: renaming one breaks pool creation against this vault.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultConfig {
    pub stake_token: Address,
    pub oracle: Address,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct YieldAccrual {
    /// Normalized principal shares whose value is derived from YieldIndex.
    pub principal: i128,
    pub withdrawn: bool,
    pub deposited_at: u64,
    /// Zero identifies a legacy position which is migrated lazily.
    pub index_entry: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct YieldIndex {
    pub value: i128,
    pub last_updated: u64,
    pub rate_bps: u32,
}

#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RwaError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NoDeposit = 3,
    Unauthorized = 4,
    AlreadyWithdrawn = 5,
    InsufficientBalance = 6,
    ArithmeticOverflow = 7,
    InvalidAmount = 8,
    /// Returned when no admin transfer proposal is pending.
    NoPendingAdmin = 9,
    /// Returned when a non-admin caller attempts to propose a new admin.
    NotAdmin = 10,
}
