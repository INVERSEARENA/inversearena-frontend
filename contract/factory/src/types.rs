use soroban_sdk::{Address, contracterror, contracttype};

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolConfig {
    pub stake_token: Address,
    pub yield_vault: Address,
    pub entry_fee: i128,
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
}
