use crate::types::{PendingAdmin, RwaConfig, RwaError, YieldAccrual, YieldIndex};
use soroban_sdk::{Address, Env, symbol_short};

// Extend TTL whenever a persistent key is read or written (#1076, #1077).
const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

#[soroban_sdk::contracttype]
enum DataKey {
    Position(Address),
    YieldIndex,
    /// Principal a position has deposited and not yet withdrawn (#1633).
    /// Kept beside `Position` rather than inside `YieldAccrual` so existing
    /// position entries still decode; a position without one has basis 0.
    Basis(Address),
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
                deposited_at: 0,
                index_entry: 0,
            })
    }

    pub fn load_yield_index(env: &Env) -> Option<YieldIndex> {
        Self::extend_ttl(env, &DataKey::YieldIndex);
        env.storage().persistent().get(&DataKey::YieldIndex)
    }

    pub fn save_yield_index(env: &Env, index: &YieldIndex) {
        Self::extend_ttl(env, &DataKey::YieldIndex);
        env.storage().persistent().set(&DataKey::YieldIndex, index);
    }

    pub fn save_position(env: &Env, user: &Address, pos: &YieldAccrual) {
        Self::extend_ttl(env, &DataKey::Position(user.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::Position(user.clone()), pos);
    }

    pub fn load_basis(env: &Env, user: &Address) -> i128 {
        let key = DataKey::Basis(user.clone());
        Self::extend_ttl(env, &key);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    pub fn save_basis(env: &Env, user: &Address, basis: i128) {
        let key = DataKey::Basis(user.clone());
        if basis == 0 {
            env.storage().persistent().remove(&key);
            return;
        }
        env.storage().persistent().set(&key, &basis);
        Self::extend_ttl(env, &key);
    }

    // ── Pending Admin ─────────────────────────────────────────────────────

    pub fn save_pending_admin(env: &Env, pending: &PendingAdmin) {
        Self::extend_ttl(env, &symbol_short!("PADMIN"));
        env.storage()
            .persistent()
            .set(&symbol_short!("PADMIN"), pending);
    }

    pub fn load_pending_admin(env: &Env) -> Option<PendingAdmin> {
        Self::extend_ttl(env, &symbol_short!("PADMIN"));
        env.storage().persistent().get(&symbol_short!("PADMIN"))
    }

    pub fn delete_pending_admin(env: &Env) {
        env.storage().persistent().remove(&symbol_short!("PADMIN"));
    }
}
