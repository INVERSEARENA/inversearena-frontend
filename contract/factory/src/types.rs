use soroban_sdk::{Address, contracterror, contracttype};

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolConfig {
    pub stake_token: Address,
    pub yield_vault: Address,
    pub entry_fee: i128,
    pub oracle_contract: Address,
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
    MaxActivePoolsReached = 10,
    PoolNotFound = 11,
    ContractPaused = 12,
}
