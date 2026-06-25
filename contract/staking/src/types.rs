use soroban_sdk::{contracterror, contracttype};

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
}
