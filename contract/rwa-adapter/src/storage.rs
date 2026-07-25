use crate::types::{RwaConfig, RwaError, YieldAccrual};
use soroban_sdk::{Address, Env, symbol_short};

// Extend TTL whenever a persistent key is read or written (#1076, #1077).
const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

#[soroban_sdk::contracttype]
enum DataKey {
    Position(Address),
}

pub struct RwaStorage;

impl RwaStorage {
    fn extend_ttl<K>(env: &Env, key: &K)
    where
        K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
    {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(
                key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND_TO,
            );
        }
    }

    pub fn assert_initialized(env: &Env) -> Result<(), RwaError> {
        Self::extend_ttl(env, &symbol_short!("RWAINIT"));
        env.storage()
            .persistent()
            .get::<soroban_sdk::Symbol, bool>(&symbol_short!("RWAINIT"))
            .filter(|v| *v)
            .ok_or(RwaError::NotInitialized)
            .map(|_| ())
    }

    pub fn set_initialized(env: &Env) {
        Self::extend_ttl(env, &symbol_short!("RWAINIT"));
        env.storage()
            .persistent()
            .set(&symbol_short!("RWAINIT"), &true);
    }

    pub fn load_config(env: &Env) -> Result<RwaConfig, RwaError> {
        Self::extend_ttl(env, &symbol_short!("RWACONFIG"));
        env.storage()
            .persistent()
            .get(&symbol_short!("RWACONFIG"))
            .ok_or(RwaError::NotInitialized)
    }

    pub fn save_config(env: &Env, config: &RwaConfig) {
        Self::extend_ttl(env, &symbol_short!("RWACONFIG"));
        env.storage()
            .persistent()
            .set(&symbol_short!("RWACONFIG"), config);
    }

    pub fn load_position(env: &Env, user: &Address) -> YieldAccrual {
        Self::extend_ttl(env, &DataKey::Position(user.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::Position(user.clone()))
            .unwrap_or(YieldAccrual {
                principal: 0,
                withdrawn: false,
            })
    }

    pub fn save_position(env: &Env, user: &Address, pos: &YieldAccrual) {
        Self::extend_ttl(env, &DataKey::Position(user.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::Position(user.clone()), pos);
    }
}
