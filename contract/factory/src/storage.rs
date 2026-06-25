use crate::types::{ArenaMetadata, ArenaStatus, FactoryError};
use soroban_sdk::{Address, BytesN, Env, contracttype};

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
}

#[contracttype]
#[derive(Clone)]
pub struct CreatorStakeRecord {
    pub creator: Address,
    pub amount: i128,
}

pub struct FactoryStorage;

impl FactoryStorage {
    pub fn has_admin(env: &Env) -> bool {
        env.storage().persistent().has(&DataKey::Admin)
    }

    pub fn save_admin(env: &Env, admin: &Address) {
        env.storage().persistent().set(&DataKey::Admin, admin);
    }

    pub fn load_admin(env: &Env) -> Result<Address, FactoryError> {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(FactoryError::NotInitialized)
    }

    pub fn save_min_stake(env: &Env, min_stake: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::MinStake, &min_stake);
    }

    pub fn load_min_stake(env: &Env) -> Result<i128, FactoryError> {
        env.storage()
            .persistent()
            .get(&DataKey::MinStake)
            .ok_or(FactoryError::NotInitialized)
    }

    pub fn set_whitelisted(env: &Env, host: &Address, whitelisted: bool) {
        env.storage()
            .persistent()
            .set(&DataKey::Whitelisted(host.clone()), &whitelisted);
    }

    pub fn is_whitelisted(env: &Env, host: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Whitelisted(host.clone()))
            .unwrap_or(false)
    }

    pub fn save_arena_wasm_hash(env: &Env, wasm_hash: &BytesN<32>) {
        env.storage()
            .persistent()
            .set(&DataKey::ArenaWasmHash, wasm_hash);
    }

    pub fn load_arena_wasm_hash(env: &Env) -> Result<BytesN<32>, FactoryError> {
        env.storage()
            .persistent()
            .get(&DataKey::ArenaWasmHash)
            .ok_or(FactoryError::WasmHashNotSet)
    }

    pub fn next_pool_id(env: &Env) -> Result<u32, FactoryError> {
        let current = env
            .storage()
            .persistent()
            .get(&DataKey::PoolSequence)
            .unwrap_or(0u32);
        let next = current.checked_add(1).ok_or(FactoryError::PoolLimitReached)?;
        env.storage()
            .persistent()
            .set(&DataKey::PoolSequence, &next);
        Ok(next)
    }

    pub fn set_approved_vault(env: &Env, vault: &Address, approved: bool) {
        env.storage()
            .persistent()
            .set(&DataKey::ApprovedVault(vault.clone()), &approved);
    }

    pub fn is_approved_vault(env: &Env, vault: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::ApprovedVault(vault.clone()))
            .unwrap_or(false)
    }

    pub fn set_approved_oracle(env: &Env, oracle: &Address, approved: bool) {
        env.storage()
            .persistent()
            .set(&DataKey::ApprovedOracle(oracle.clone()), &approved);
    }

    pub fn is_approved_oracle(env: &Env, oracle: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::ApprovedOracle(oracle.clone()))
            .unwrap_or(false)
    }

    pub fn save_creator_stake(env: &Env, arena: &Address, record: &CreatorStakeRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::CreatorStake(arena.clone()), record);
    }

    pub fn load_creator_stake(env: &Env, arena: &Address) -> Option<CreatorStakeRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::CreatorStake(arena.clone()))
    }

    // ── Active Pool Count ─────────────────────────────────────────────────

    pub fn load_active_pool_count(env: &Env, creator: &Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::ActivePoolCount(creator.clone()))
            .unwrap_or(0)
    }

    pub fn save_active_pool_count(env: &Env, creator: &Address, count: u32) {
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
        env.storage().persistent().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn set_paused(env: &Env, paused: bool) {
        env.storage().persistent().set(&DataKey::Paused, &paused);
    }

    // ── Pool Metadata ─────────────────────────────────────────────────────

    pub fn pool_count(env: &Env) -> u32 {
        env.storage().persistent().get(&DataKey::PoolCount).unwrap_or(0)
    }

    pub fn save_pool(env: &Env, pool_id: u32, metadata: &ArenaMetadata) {
        env.storage()
            .persistent()
            .set(&DataKey::Pool(pool_id), metadata);
    }

    pub fn load_pool(env: &Env, pool_id: u32) -> Option<ArenaMetadata> {
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
        env.storage().persistent().set(&DataKey::PoolCount, &count);
        count
    }

    // ── Max Active Pools Config ───────────────────────────────────────────

    pub fn has_max_active_pools(env: &Env) -> bool {
        env.storage().persistent().has(&DataKey::MaxActivePools)
    }

    pub fn load_max_active_pools(env: &Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::MaxActivePools)
            .unwrap_or(10)
    }

    pub fn save_max_active_pools(env: &Env, max: u32) {
        env.storage()
            .persistent()
            .set(&DataKey::MaxActivePools, &max);
    }
}
