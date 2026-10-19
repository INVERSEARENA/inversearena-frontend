#![allow(dead_code)]
use crate::types::{ArenaMetadata, ArenaStatus, FactoryError, MAX_ARENAS_PAGE_SIZE};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Val, Vec, contracttype};

const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

#[contracttype]
pub enum DataKey {
    CreatorStake(Address),
    Admin,
    PendingAdmin,
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
    SupportedTokens,
    /// Instance-storage flag for the protocol-wide emergency pause (#1583).
    GlobalPaused,
    /// #1613: Number of pools indexed for a host (all pages combined).
    HostPoolCount(Address),
    /// #1613: One page of the host's pool-ID index.
    HostPoolPage(Address, u32),
    /// #1613: Bucket of pool IDs currently in an arena status.
    StatusBucket(ArenaStatus),
}

#[contracttype]
#[derive(Clone)]
pub struct CreatorStakeRecord {
    pub creator: Address,
    pub amount: i128,
    /// Token the stake was collected in, so it can be refunded on reclaim.
    pub stake_token: Address,
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

    pub fn save_pending_admin(env: &Env, admin: &Address) {
        Self::extend_persistent_ttl(env, &DataKey::PendingAdmin);
        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, admin);
    }

    pub fn load_pending_admin(env: &Env) -> Option<Address> {
        Self::extend_persistent_ttl(env, &DataKey::PendingAdmin);
        env.storage().persistent().get(&DataKey::PendingAdmin)
    }

    pub fn delete_pending_admin(env: &Env) {
        env.storage()
            .persistent()
            .remove(&DataKey::PendingAdmin);
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
        let next = current
            .checked_add(1)
            .ok_or(FactoryError::PoolLimitReached)?;
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

    pub fn remove_creator_stake(env: &Env, arena: &Address) {
        env.storage()
            .persistent()
            .remove(&DataKey::CreatorStake(arena.clone()));
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
        let new = current.checked_add(1).unwrap_or(u32::MAX);
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
        env.storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn set_paused(env: &Env, paused: bool) {
        Self::extend_persistent_ttl(env, &DataKey::Paused);
        env.storage().persistent().set(&DataKey::Paused, &paused);
    }

    /// Protocol-wide emergency pause read by every arena (#1583).
    ///
    /// Kept in instance storage: invoking the factory already loads its
    /// instance entry, so an arena's cross-contract check adds no further
    /// ledger entry. The read never extends a TTL.
    pub fn is_globally_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::GlobalPaused)
            .unwrap_or(false)
    }

    pub fn set_globally_paused(env: &Env, paused: bool) {
        env.storage().instance().set(&DataKey::GlobalPaused, &paused);
        env.storage().instance().extend_ttl(
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
    }

    // ── Pool Metadata ─────────────────────────────────────────────────────

    pub fn pool_count(env: &Env) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::PoolCount);
        env.storage()
            .persistent()
            .get(&DataKey::PoolCount)
            .unwrap_or(0)
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

        let current: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::SupportedTokens)
            .unwrap_or(Vec::new(env));
        let mut next = Vec::new(env);
        for index in 0..current.len() {
            if let Some(existing) = current.get(index) {
                if existing != *token {
                    next.push_back(existing);
                }
            }
        }
        if supported {
            next.push_back(token.clone());
        }
        env.storage().persistent().set(&DataKey::SupportedTokens, &next);
    }

    pub fn list_supported_tokens(env: &Env, offset: u32, limit: u32) -> Vec<Address> {
        let current: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::SupportedTokens)
            .unwrap_or(Vec::new(env));
        let end = offset.saturating_add(limit.min(50)).min(current.len());
        let mut result = Vec::new(env);
        for index in offset..end {
            if let Some(token) = current.get(index) {
                result.push_back(token);
            }
        }
        result
    }

    pub fn is_supported_token(env: &Env, token: &Address) -> bool {
        Self::extend_persistent_ttl(env, &DataKey::SupportedToken(token.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::SupportedToken(token.clone()))
            .unwrap_or(false)
    }

    // ── Secondary indexes (#1613) ───────────────────────────────────────────

    /// Number of pool IDs stored per page of the host index. Matches
    /// `MAX_ARENAS_PAGE_SIZE` so host paging and arena paging stay aligned.
    pub const HOST_POOLS_PAGE_SIZE: u32 = MAX_ARENAS_PAGE_SIZE;

    /// Append `pool_id` to the host's pool index, spilling into a new page
    /// once the current one holds `HOST_POOLS_PAGE_SIZE` entries.
    pub fn index_host_pool(env: &Env, host: &Address, pool_id: u32) {
        let count_key = DataKey::HostPoolCount(host.clone());
        Self::extend_persistent_ttl(env, &count_key);
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);

        let page_key = DataKey::HostPoolPage(host.clone(), count / Self::HOST_POOLS_PAGE_SIZE);
        Self::extend_persistent_ttl(env, &page_key);
        let mut page: Vec<u32> = env.storage().persistent().get(&page_key).unwrap_or(Vec::new(env));
        page.push_back(pool_id);

        env.storage().persistent().set(&page_key, &page);
        env.storage().persistent().set(&count_key, &(count + 1));
    }

    /// Total pools indexed for `host` across all pages.
    pub fn host_pool_count(env: &Env, host: &Address) -> u32 {
        let count_key = DataKey::HostPoolCount(host.clone());
        Self::extend_persistent_ttl(env, &count_key);
        env.storage().persistent().get(&count_key).unwrap_or(0)
    }

    /// Return page `page` (0-indexed) of the host's pool-ID index. An empty
    /// page means the caller has iterated past the end.
    pub fn get_host_pools_page(env: &Env, host: &Address, page: u32) -> Vec<u32> {
        let page_key = DataKey::HostPoolPage(host.clone(), page);
        Self::extend_persistent_ttl(env, &page_key);
        env.storage().persistent().get(&page_key).unwrap_or(Vec::new(env))
    }

    fn load_status_bucket(env: &Env, status: &ArenaStatus) -> Vec<u32> {
        let key = DataKey::StatusBucket(status.clone());
        Self::extend_persistent_ttl(env, &key);
        env.storage().persistent().get(&key).unwrap_or(Vec::new(env))
    }

    fn save_status_bucket(env: &Env, status: &ArenaStatus, ids: &Vec<u32>) {
        let key = DataKey::StatusBucket(status.clone());
        Self::extend_persistent_ttl(env, &key);
        env.storage().persistent().set(&key, ids);
    }

    fn position_of(ids: &Vec<u32>, pool_id: u32) -> Option<u32> {
        for i in 0..ids.len() {
            if ids.get(i) == Some(pool_id) {
                return Some(i);
            }
        }
        None
    }

    /// Add `pool_id` to `status`'s bucket. Idempotent: re-indexing an ID that
    /// is already present is a no-op.
    pub fn index_pool_status(env: &Env, pool_id: u32, status: &ArenaStatus) {
        let mut ids = Self::load_status_bucket(env, status);
        if Self::position_of(&ids, pool_id).is_none() {
            ids.push_back(pool_id);
            Self::save_status_bucket(env, status, &ids);
        }
    }

    /// Move `pool_id` from the `from` bucket to the `to` bucket using an
    /// O(1) swap-remove — bucket order is not stable across transitions.
    pub fn transition_pool_status(env: &Env, pool_id: u32, from: &ArenaStatus, to: &ArenaStatus) {
        let mut old = Self::load_status_bucket(env, from);
        if let Some(pos) = Self::position_of(&old, pool_id) {
            let last_index = old.len() - 1;
            if pos == last_index {
                old.pop_back();
            } else if let Some(tail) = old.pop_back() {
                old.set(pos, tail);
            }
            Self::save_status_bucket(env, from, &old);
        }

        let mut new = Self::load_status_bucket(env, to);
        if Self::position_of(&new, pool_id).is_none() {
            new.push_back(pool_id);
            Self::save_status_bucket(env, to, &new);
        }
    }

    /// Slice the `status` bucket at `offset` / `limit` (clamped to
    /// `MAX_ARENAS_PAGE_SIZE`). Ordering is NOT stable across transitions.
    pub fn get_pools_by_status(env: &Env, status: &ArenaStatus, offset: u32, limit: u32) -> Vec<u32> {
        let ids = Self::load_status_bucket(env, status);
        let start = offset.min(ids.len());
        let end = start.saturating_add(limit.min(MAX_ARENAS_PAGE_SIZE)).min(ids.len());
        let mut out: Vec<u32> = Vec::new(env);
        for i in start..end {
            if let Some(id) = ids.get(i) {
                out.push_back(id);
            }
        }
        out
    }

    /// Wire ordinal for `status`, used by the versioned `pool_st` event payload.
    pub fn arena_status_ordinal(status: &ArenaStatus) -> u32 {
        match status {
            ArenaStatus::Pending => 0,
            ArenaStatus::Active => 1,
            ArenaStatus::Finished => 2,
            ArenaStatus::Cancelled => 3,
        }
    }
}
