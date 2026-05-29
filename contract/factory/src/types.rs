use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FactoryError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidStakeAmount = 4,
    InsufficientCreatorStake = 5,
    ArenaNotFound = 6,
}
