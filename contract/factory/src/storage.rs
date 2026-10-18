#![allow(dead_code)]
use crate::types::{ArenaMetadata, ArenaStatus, FactoryError};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Val, Vec, contracttype};

const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

/// Maximum pool IDs stored per HostPools page. Bounded to keep storage reads
/// O(1) per page and predictable ledger overhead.
pub const HOST_POOLS_PAGE_SIZE: u32 = 50;

/// Maximum pool IDs stored per StatusBucket. O(1) swap-remove keeps
/// `update_arena_status` at constant cost regardless of bucket size.
pub const STATUS_BUCKET_MAX: u32 = 200;

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
    /// Secondary index: pool IDs created by a specific host, paged.
    /// Key = (host Address, page index u32) → Vec<pool_id u32>
    HostPoolsPage(Address, u32),
    /// Number of pages in HostPools for a given host.
    HostPoolsPageCount(Address),
    /// Secondary index: pool IDs in a given status bucket.
    /// Key = status ordinal (0=Pending, 1=Active, 2=Finished, 3=Cancelled) → Vec<pool_id u32>
    StatusBucket(u32),
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

    // ── HostPools secondary index (#1613) ─────────────────────────────────
    //
    // `HostPools(host) → paged Vec<pool_id>` lets callers query a host's
    // pools in O(page) without scanning the entire pool list.
    //
    // Paging strategy: each page holds up to HOST_POOLS_PAGE_SIZE pool IDs.
    // `HostPoolsPageCount(host)` tracks the total number of pages allocated.
    // New IDs are appended to the last page; once full a new page is created.

    fn load_host_pools_page_count(env: &Env, host: &Address) -> u32 {
        Self::extend_persistent_ttl(env, &DataKey::HostPoolsPageCount(host.clone()));
        env.storage()
            .persistent()
            .get(&DataKey::HostPoolsPageCount(host.clone()))
            .unwrap_or(0)
    }

    fn save_host_pools_page_count(env: &Env, host: &Address, count: u32) {
        Self::extend_persistent_ttl(env, &DataKey::HostPoolsPageCount(host.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::HostPoolsPageCount(host.clone()), &count);
    }

    fn load_host_pools_page(env: &Env, host: &Address, page: u32) -> Vec<u32> {
        Self::extend_persistent_ttl(env, &DataKey::HostPoolsPage(host.clone(), page));
        env.storage()
            .persistent()
            .get(&DataKey::HostPoolsPage(host.clone(), page))
            .unwrap_or_else(|| Vec::new(env))
    }

    fn save_host_pools_page(env: &Env, host: &Address, page: u32, ids: &Vec<u32>) {
        Self::extend_persistent_ttl(env, &DataKey::HostPoolsPage(host.clone(), page));
        env.storage()
            .persistent()
            .set(&DataKey::HostPoolsPage(host.clone(), page), ids);
    }

    /// Append `pool_id` to the HostPools index for `host`.  Called atomically
    /// from `create_pool` so the index is always consistent with the pool
    /// record (#1613).
    pub fn index_host_pool(env: &Env, host: &Address, pool_id: u32) {
        let page_count = Self::load_host_pools_page_count(env, host);

        // Find the last page; create the first page when count == 0.
        let (page_index, mut page) = if page_count == 0 {
            (0u32, Vec::new(env))
        } else {
            let last = page_count - 1;
            let p = Self::load_host_pools_page(env, host, last);
            (last, p)
        };

        if page.len() < HOST_POOLS_PAGE_SIZE {
            // Still room on the current last page.
            page.push_back(pool_id);
            Self::save_host_pools_page(env, host, page_index, &page);
            if page_count == 0 {
                Self::save_host_pools_page_count(env, host, 1);
            }
        } else {
            // Current page is full; open a new one.
            let new_page_index = page_index.saturating_add(1);
            let mut new_page = Vec::new(env);
            new_page.push_back(pool_id);
            Self::save_host_pools_page(env, host, new_page_index, &new_page);
            Self::save_host_pools_page_count(env, host, new_page_index + 1);
        }
    }

    /// Return a page of pool IDs for `host`.  `page` is 0-indexed.
    /// Returns an empty Vec when the page doesn't exist.
    pub fn get_host_pools_page(env: &Env, host: &Address, page: u32) -> Vec<u32> {
        Self::load_host_pools_page(env, host, page)
    }

    /// Total number of pools indexed for `host` (sum across all pages).
    pub fn host_pool_count(env: &Env, host: &Address) -> u32 {
        let page_count = Self::load_host_pools_page_count(env, host);
        if page_count == 0 {
            return 0;
        }
        // All pages except the last are full; last page may be partial.
        let last = page_count - 1;
        let full_pages = last;
        let last_page_len = Self::load_host_pools_page(env, host, last).len();
        full_pages.saturating_mul(HOST_POOLS_PAGE_SIZE).saturating_add(last_page_len)
    }

    // ── StatusBucket secondary index (#1613) ──────────────────────────────
    //
    // `StatusBucket(status_ordinal) → Vec<pool_id>` tracks which pool IDs are
    // in each status.  Status changes use swap-remove to keep the operation
    // O(1) — the cost of `update_arena_status` does not grow with pool count.
    //
    // Ordinals: 0=Pending, 1=Active, 2=Finished, 3=Cancelled  (matches
    // `ArenaStatus` variant order in types.rs).

    pub(crate) fn arena_status_ordinal(status: &ArenaStatus) -> u32 {
        match status {
            ArenaStatus::Pending   => 0,
            ArenaStatus::Active    => 1,
            ArenaStatus::Finished  => 2,
            ArenaStatus::Cancelled => 3,
        }
    }

    fn load_status_bucket(env: &Env, ordinal: u32) -> Vec<u32> {
        Self::extend_persistent_ttl(env, &DataKey::StatusBucket(ordinal));
        env.storage()
            .persistent()
            .get(&DataKey::StatusBucket(ordinal))
            .unwrap_or_else(|| Vec::new(env))
    }

    fn save_status_bucket(env: &Env, ordinal: u32, ids: &Vec<u32>) {
        Self::extend_persistent_ttl(env, &DataKey::StatusBucket(ordinal));
        env.storage()
            .persistent()
            .set(&DataKey::StatusBucket(ordinal), ids);
    }

    /// Insert `pool_id` into the bucket for `status`.  Called from
    /// `create_pool` when a new pool is registered (initial status = Pending).
    pub fn index_pool_status(env: &Env, pool_id: u32, status: &ArenaStatus) {
        let ordinal = Self::arena_status_ordinal(status);
        let mut bucket = Self::load_status_bucket(env, ordinal);
        // Avoid duplicates (idempotent).
        for i in 0..bucket.len() {
            if bucket.get(i) == Some(pool_id) {
                return;
            }
        }
        bucket.push_back(pool_id);
        Self::save_status_bucket(env, ordinal, &bucket);
    }

    /// Move `pool_id` from `old_status` bucket to `new_status` bucket.
    ///
    /// Removal is O(1) via swap-remove: find the target ID, swap with the
    /// last element, then pop — so cursor positions of other IDs in the
    /// bucket are not predictably stable across status transitions.  Callers
    /// must not store bucket-local positions as stable cursors.
    pub fn transition_pool_status(
        env: &Env,
        pool_id: u32,
        old_status: &ArenaStatus,
        new_status: &ArenaStatus,
    ) {
        let old_ord = Self::arena_status_ordinal(old_status);
        let new_ord = Self::arena_status_ordinal(new_status);
        if old_ord == new_ord {
            return;
        }

        // O(1) swap-remove from old bucket.
        let mut old_bucket = Self::load_status_bucket(env, old_ord);
        let len = old_bucket.len();
        let mut found_at: Option<u32> = None;
        for i in 0..len {
            if old_bucket.get(i) == Some(pool_id) {
                found_at = Some(i);
                break;
            }
        }
        if let Some(idx) = found_at {
            if idx < len - 1 {
                // Swap the target with the last element.
                let last = old_bucket.get(len - 1).unwrap();
                old_bucket.set(idx, last);
            }
            old_bucket.pop_back();
            Self::save_status_bucket(env, old_ord, &old_bucket);
        }

        // Append to new bucket.
        let mut new_bucket = Self::load_status_bucket(env, new_ord);
        new_bucket.push_back(pool_id);
        Self::save_status_bucket(env, new_ord, &new_bucket);
    }

    /// Return a page of pool IDs in a given `status`.
    ///
    /// `offset` / `limit` are plain slice semantics over the flat bucket Vec.
    /// Because swap-remove can reorder IDs on each status transition, callers
    /// must not rely on stable ordering; use pool-ID-based cursor semantics
    /// (re-scan from the beginning) after any status-changing call.
    pub fn get_pools_by_status(env: &Env, status: &ArenaStatus, offset: u32, limit: u32) -> Vec<u32> {
        let ordinal = Self::arena_status_ordinal(status);
        let bucket = Self::load_status_bucket(env, ordinal);
        let clamped = limit.min(crate::types::MAX_ARENAS_PAGE_SIZE);
        let end = offset.saturating_add(clamped).min(bucket.len());
        let mut result = Vec::new(env);
        for i in offset..end {
            if let Some(id) = bucket.get(i) {
                result.push_back(id);
            }
        }
        result
    }
}
