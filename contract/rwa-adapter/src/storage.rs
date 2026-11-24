use crate::types::{PendingAdmin, RwaConfig, RwaError, StrategyRecord, YieldAccrual, YieldIndex};
use soroban_sdk::{Address, Env, Vec, symbol_short};

// Extend TTL whenever a persistent key is read or written (#1076, #1077).
const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

#[soroban_sdk::contracttype]
enum DataKey {
    StorageVersion,
    Position(Address),
    YieldIndex,
    /// Principal a position has deposited and not yet withdrawn (#1633).
    /// Kept beside `Position` rather than inside `YieldAccrual` so existing
    /// position entries still decode; a position without one has basis 0.
    Basis(Address),
    /// Reserved for future use/extensions.
    _YieldReserve,
    /// Tracks the total principal deposited across all positions (#1628).
    _PrincipalTotal,
    /// Registered strategies in insertion order (#1848).
    Strategies,
    /// Total shares outstanding against strategy assets.
    ShareSupply,
    /// A depositor's shares of strategy assets.
    Shares(Address),
}

pub const CURRENT_STORAGE_VERSION: u32 = 1;
pub struct RwaStorage;

impl RwaStorage {
    pub fn load_storage_version(env: &Env) -> u32 { env.storage().persistent().get(&DataKey::StorageVersion).unwrap_or(CURRENT_STORAGE_VERSION) }
    pub fn save_storage_version(env: &Env, v: u32) { env.storage().persistent().set(&DataKey::StorageVersion, &v); }
    pub fn require_current_storage_version(env: &Env) -> Result<(), RwaError> {
        if Self::load_storage_version(env) < CURRENT_STORAGE_VERSION { return Err(RwaError::MigrationPending); }
        Ok(())
    }
    pub fn migrate(env: &Env, _max_steps: u32) -> u32 { Self::save_storage_version(env, CURRENT_STORAGE_VERSION); CURRENT_STORAGE_VERSION }

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

    pub fn set_factory(env: &Env, factory: &Address) {
        env.storage()
            .instance()
            .set(&symbol_short!("FACTORY"), factory);
    }

    pub fn load_factory(env: &Env) -> Option<Address> {
        env.storage().instance().get(&symbol_short!("FACTORY"))
    }

    pub fn load_strategies(env: &Env) -> Vec<StrategyRecord> {
        let key = DataKey::Strategies;
        Self::extend_ttl(env, &key);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn save_strategies(env: &Env, strategies: &Vec<StrategyRecord>) {
        let key = DataKey::Strategies;
        env.storage().persistent().set(&key, strategies);
        Self::extend_ttl(env, &key);
    }

    pub fn strategy_count(env: &Env) -> u32 {
        Self::load_strategies(env).len()
    }

    pub fn share_supply(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ShareSupply)
            .unwrap_or(0)
    }

    pub fn set_share_supply(env: &Env, supply: i128) {
        env.storage().instance().set(&DataKey::ShareSupply, &supply);
    }

    pub fn user_shares(env: &Env, user: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Shares(user.clone()))
            .unwrap_or(0)
    }

    pub fn set_user_shares(env: &Env, user: &Address, shares: i128) {
        let key = DataKey::Shares(user.clone());
        if shares == 0 {
            env.storage().persistent().remove(&key);
            return;
        }
        env.storage().persistent().set(&key, &shares);
        Self::extend_ttl(env, &key);
    }
}
