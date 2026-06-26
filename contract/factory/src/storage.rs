use crate::types::{ArenaMetadata, ArenaStatus, FactoryError};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Val, contracttype};

const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

#[contracttype]
pub enum DataKey {
    CreatorStake(Address),
    Admin,
    MinStake,
    ArenaWasmHash,
    PoolSequence,
    Whitelisted(Address),
    ApprovedVault(Address),
    ApprovedOracle(Address),
    ActivePoolCount(Address),
    MaxActivePools,
    PoolCount,
    Pool(u32),
    Paused,
    SupportedToken(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct CreatorStakeRecord {
    pub creator: Address,
    pub amount: i128,
}

pub struct FactoryStorage;

impl FactoryStorage {
    fn extend_persistent_ttl<K>(env: &Env, key: &K)
    where
        K: IntoVal<Env, Val>,
    {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(
                key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND_TO,
            );
        }
    }

    pub fn has_admin(env: &Env) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::Admin);
        env.storage().persistent().has(&DataKey::Admin)
    }

    pub fn save_admin(env: &Env, admin: &Address) {
        Self::extend_persistent_ttl(env, &DataKey::Admin);
        env.storage().persistent().set(&DataKey::Admin, admin);
    }

    pub fn load_admin(env: &Env) -> Result<Address, FactoryError> {
        Self::extend_persistent_ttl(env, &DataKey::Admin);
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(FactoryError::NotInitialized)
    }

    pub fn save_min_stake(env: &Env, min_stake: i128) {
        Self::extend_persistent_ttl(env, &DataKey::MinStake);
        env.storage()
            .persistent()
            .set(&DataKey::MinStake, &min_stake);
    }

    pub fn load_min_stake(env: &Env) -> Result<i128, FactoryError> {
        Self::extend_persistent_ttl(env, &DataKey::MinStake);
        env.storage()
            .persistent()
            .get(&DataKey::MinStake)
            .ok_or(FactoryError::NotInitialized)
    }

    pub fn set_whitelisted(env: &Env, host: &Address, whitelisted: bool) {
        Self::extend_persistent_ttl(env, &DataKey::Whitelisted(host.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::Whitelisted(host.clone()), &whitelisted);
    }

    pub fn is_whitelisted(env: &Env, host: &Address) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::Whitelisted(host.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::Whitelisted(host.clone()))
            .unwrap_or(false)
    }

    pub fn save_arena_wasm_hash(env: &Env, wasm_hash: &BytesN<32>) {
        Self::extend_persistent_ttl(env, &DataKey::ArenaWasmHash);
        env.storage()
            .persistent()
            .set(&DataKey::ArenaWasmHash, wasm_hash);
    }

    pub fn load_arena_wasm_hash(env: &Env) -> Result<BytesN<32>, FactoryError> {
        Self::extend_persistent_ttl(env, &DataKey::ArenaWasmHash);
        env.storage()
            .persistent()
            .get(&DataKey::ArenaWasmHash)
            .ok_or(FactoryError::WasmHashNotSet)
    }

    pub fn next_pool_id(env: &Env) -> Result<u32, FactoryError> {
        Self::extend_persistent_ttl(env, &DataKey::PoolSequence);
        let current = env
            .storage()
            .persistent()
            .get(&DataKey::PoolSequence)
            .unwrap_or(0u32);
        let next = current.checked_add(1).ok_or(FactoryError::PoolLimitReached)?;
        Self::extend_persistent_ttl(env, &DataKey::PoolSequence);
        env.storage()
            .persistent()
            .set(&DataKey::PoolSequence, &next);
        Ok(next)
    }

    pub fn set_approved_vault(env: &Env, vault: &Address, approved: bool) {
        Self::extend_persistent_ttl(env, &DataKey::ApprovedVault(vault.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::ApprovedVault(vault.clone()), &approved);
    }

    pub fn is_approved_vault(env: &Env, vault: &Address) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::ApprovedVault(vault.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::ApprovedVault(vault.clone()))
            .unwrap_or(false)
    }

    pub fn set_approved_oracle(env: &Env, oracle: &Address, approved: bool) {
        Self::extend_persistent_ttl(env, &DataKey::ApprovedOracle(oracle.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::ApprovedOracle(oracle.clone()), &approved);
    }

    pub fn is_approved_oracle(env: &Env, oracle: &Address) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::ApprovedOracle(oracle.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::ApprovedOracle(oracle.clone()))
            .unwrap_or(false)
    }

    pub fn save_creator_stake(env: &Env, arena: &Address, record: &CreatorStakeRecord) {
        Self::extend_persistent_ttl(env, &DataKey::CreatorStake(arena.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::CreatorStake(arena.clone()), record);
    }

    pub fn load_creator_stake(env: &Env, arena: &Address) -> Option<CreatorStakeRecord> {
        Self::extend_persistent_ttl(env, &DataKey::CreatorStake(arena.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::CreatorStake(arena.clone()))
    }

    // ── Active Pool Count ─────────────────────────────────────────────────

    pub fn load_active_pool_count(env: &Env, creator: &Address) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::ActivePoolCount(creator.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::ActivePoolCount(creator.clone()))
            .unwrap_or(0)
    }

    pub fn save_active_pool_count(env: &Env, creator: &Address, count: u32) {
        Self::extend_persistent_ttl(env, &DataKey::ActivePoolCount(creator.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::ActivePoolCount(creator.clone()), &count);
    }

    pub fn increment_active_pool_count(env: &Env, creator: &Address) -> u32 {
        let current = Self::load_active_pool_count(env, creator);
        let new = current + 1;
        Self::save_active_pool_count(env, creator, new);
        new
    }

    pub fn decrement_active_pool_count(env: &Env, creator: &Address) -> u32 {
        let current = Self::load_active_pool_count(env, creator);
        if current > 0 {
            let new = current - 1;
            Self::save_active_pool_count(env, creator, new);
            new
        } else {
            0
        }
    }

    // ── Pause / Unpause ───────────────────────────────────────────────────

    pub fn is_paused(env: &Env) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::Paused);
        env.storage().persistent().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn set_paused(env: &Env, paused: bool) {
        Self::extend_persistent_ttl(env, &DataKey::Paused);
        env.storage().persistent().set(&DataKey::Paused, &paused);
    }

    // ── Pool Metadata ─────────────────────────────────────────────────────

    pub fn pool_count(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::PoolCount);
        env.storage().persistent().get(&DataKey::PoolCount).unwrap_or(0)
    }

    pub fn save_pool(env: &Env, pool_id: u32, metadata: &ArenaMetadata) {
        Self::extend_persistent_ttl(env, &DataKey::Pool(pool_id));
        env.storage()
            .persistent()
            .set(&DataKey::Pool(pool_id), metadata);
    }

    pub fn load_pool(env: &Env, pool_id: u32) -> Option<ArenaMetadata> {
        Self::extend_persistent_ttl(env, &DataKey::Pool(pool_id));
        env.storage().persistent().get(&DataKey::Pool(pool_id))
    }

    pub fn update_pool_status(env: &Env, pool_id: u32, status: &ArenaStatus) {
        if let Some(mut meta) = Self::load_pool(env, pool_id) {
            meta.status = status.clone();
            Self::save_pool(env, pool_id, &meta);
        }
    }

    pub fn increment_pool_count(env: &Env) -> u32 {
        let count = Self::pool_count(env) + 1;
        Self::extend_persistent_ttl(env, &DataKey::PoolCount);
        env.storage().persistent().set(&DataKey::PoolCount, &count);
        count
    }

    // ── Max Active Pools Config ───────────────────────────────────────────

    pub fn has_max_active_pools(env: &Env) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::MaxActivePools);
        env.storage().persistent().has(&DataKey::MaxActivePools)
    }

    pub fn load_max_active_pools(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::MaxActivePools);
        env.storage()
            .persistent()
            .get(&DataKey::MaxActivePools)
            .unwrap_or(10)
    }

    pub fn save_max_active_pools(env: &Env, max: u32) {
        Self::extend_persistent_ttl(env, &DataKey::MaxActivePools);
        env.storage()
            .persistent()
            .set(&DataKey::MaxActivePools, &max);
    }

    // ── Supported Token Registry ──────────────────────────────────────────

    pub fn set_supported_token(env: &Env, token: &Address, supported: bool) {
        Self::extend_persistent_ttl(env, &DataKey::SupportedToken(token.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::SupportedToken(token.clone()), &supported);
    }

    pub fn is_supported_token(env: &Env, token: &Address) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::SupportedToken(token.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::SupportedToken(token.clone()))
            .unwrap_or(false)
    }
}
