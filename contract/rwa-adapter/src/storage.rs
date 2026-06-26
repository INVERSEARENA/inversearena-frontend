use crate::types::{RwaConfig, RwaError, YieldAccrual};
use soroban_sdk::{Address, Env, symbol_short};

#[soroban_sdk::contracttype]
enum DataKey {
    Position(Address),
}

pub struct RwaStorage;

impl RwaStorage {
    pub fn assert_initialized(env: &Env) -> Result<(), RwaError> {
        env.storage()
            .persistent()
            .get::<soroban_sdk::Symbol, bool>(&symbol_short!("RWAINIT"))
            .filter(|v| *v)
            .ok_or(RwaError::NotInitialized)
            .map(|_| ())
    }

    pub fn set_initialized(env: &Env) {
        env.storage()
            .persistent()
            .set(&symbol_short!("RWAINIT"), &true);
    }

    pub fn load_config(env: &Env) -> Result<RwaConfig, RwaError> {
        env.storage()
            .persistent()
            .get(&symbol_short!("RWACONFIG"))
            .ok_or(RwaError::NotInitialized)
    }

    pub fn save_config(env: &Env, config: &RwaConfig) {
        env.storage()
            .persistent()
            .set(&symbol_short!("RWACONFIG"), config);
    }

    pub fn load_position(env: &Env, user: &Address) -> YieldAccrual {
        env.storage()
            .persistent()
            .get(&DataKey::Position(user.clone()))
            .unwrap_or(YieldAccrual {
                principal: 0,
                withdrawn: false,
            })
    }

    pub fn save_position(env: &Env, user: &Address, pos: &YieldAccrual) {
        env.storage()
            .persistent()
            .set(&DataKey::Position(user.clone()), pos);
    }
}
