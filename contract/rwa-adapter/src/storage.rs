use soroban_sdk::{Address, Env};
use crate::types::{RwaConfig, RwaError, YieldAccrual};

pub struct RwaStorage;

impl RwaStorage {
    pub fn load_config(env: &Env) -> Result<RwaConfig, RwaError> {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("CONFIG"))
            .ok_or(RwaError::NotInitialized)
    }

    pub fn save_config(env: &Env, config: &RwaConfig) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("CONFIG"), config);
    }

    pub fn has_config(env: &Env) -> bool {
        env.storage()
            .instance()
            .has(&soroban_sdk::symbol_short!("CONFIG"))
    }

    pub fn load_accrual(env: &Env, user: &Address) -> Option<YieldAccrual> {
        env.storage().persistent().get(user)
    }

    pub fn save_accrual(env: &Env, user: &Address, accrual: &YieldAccrual) {
        env.storage().persistent().set(user, accrual);
    }
}
