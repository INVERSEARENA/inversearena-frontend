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
    pub total_deposited: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct YieldAccrual {
    pub principal: i128,
    pub withdrawn: bool,
    pub deposited_at: u64,
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
