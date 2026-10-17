use crate::types::{FeeRouterError, PendingShareChange};
use soroban_sdk::{Address, Env, IntoVal, Val, contracttype};

// ─── TTL constants (matching arena/staking pattern) ──────────────────────────
const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1_000;

// ─── Storage keys ─────────────────────────────────────────────────────────────
#[contracttype]
pub enum DataKey {
    /// Protocol admin address.
    Admin,
    /// Pending admin during a two-step transfer.
    PendingAdmin,
    /// Address of the staking contract.
    StakingContract,
    /// Address of the protocol treasury.
    Treasury,
    /// `staking_share_bps`: basis-points of each flush that go to staking.
    StakingShareBps,
    /// Pending timelocked change to `StakingShareBps`.
    PendingShareChange,
    /// Accumulated token balance per token (waiting to be flushed).
    Balance(Address),
}

pub struct RouterStorage;

impl RouterStorage {
    // ── helpers ───────────────────────────────────────────────────────────────

    fn extend<K: IntoVal<Env, Val>>(env: &Env, key: &K) {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(
                key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND_TO,
            );
        }
    }

    // ── admin ─────────────────────────────────────────────────────────────────

    pub fn has_admin(env: &Env) -> bool {
        Self::extend(env, &DataKey::Admin);
        env.storage().persistent().has(&DataKey::Admin)
    }

    pub fn save_admin(env: &Env, admin: &Address) {
        env.storage().persistent().set(&DataKey::Admin, admin);
        Self::extend(env, &DataKey::Admin);
    }

    pub fn load_admin(env: &Env) -> Result<Address, FeeRouterError> {
        Self::extend(env, &DataKey::Admin);
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(FeeRouterError::NotInitialized)
    }

    pub fn save_pending_admin(env: &Env, addr: &Address) {
        env.storage().persistent().set(&DataKey::PendingAdmin, addr);
        Self::extend(env, &DataKey::PendingAdmin);
    }

    pub fn load_pending_admin(env: &Env) -> Option<Address> {
        Self::extend(env, &DataKey::PendingAdmin);
        env.storage().persistent().get(&DataKey::PendingAdmin)
    }

    pub fn delete_pending_admin(env: &Env) {
        env.storage().persistent().remove(&DataKey::PendingAdmin);
    }

    // ── staking / treasury ────────────────────────────────────────────────────

    pub fn save_staking_contract(env: &Env, addr: &Address) {
        env.storage()
            .persistent()
            .set(&DataKey::StakingContract, addr);
        Self::extend(env, &DataKey::StakingContract);
    }

    pub fn load_staking_contract(env: &Env) -> Result<Address, FeeRouterError> {
        Self::extend(env, &DataKey::StakingContract);
        env.storage()
            .persistent()
            .get(&DataKey::StakingContract)
            .ok_or(FeeRouterError::NotInitialized)
    }

    pub fn save_treasury(env: &Env, addr: &Address) {
        env.storage().persistent().set(&DataKey::Treasury, addr);
        Self::extend(env, &DataKey::Treasury);
    }

    pub fn load_treasury(env: &Env) -> Result<Address, FeeRouterError> {
        Self::extend(env, &DataKey::Treasury);
        env.storage()
            .persistent()
            .get(&DataKey::Treasury)
            .ok_or(FeeRouterError::NotInitialized)
    }

    // ── staking share bps ─────────────────────────────────────────────────────

    pub fn save_staking_share_bps(env: &Env, bps: u32) {
        env.storage()
            .persistent()
            .set(&DataKey::StakingShareBps, &bps);
        Self::extend(env, &DataKey::StakingShareBps);
    }

    pub fn load_staking_share_bps(env: &Env) -> u32 {
        Self::extend(env, &DataKey::StakingShareBps);
        env.storage()
            .persistent()
            .get(&DataKey::StakingShareBps)
            .unwrap_or(0u32)
    }

    // ── pending share change ──────────────────────────────────────────────────

    pub fn save_pending_share_change(env: &Env, change: &PendingShareChange) {
        env.storage()
            .persistent()
            .set(&DataKey::PendingShareChange, change);
        Self::extend(env, &DataKey::PendingShareChange);
    }

    pub fn load_pending_share_change(env: &Env) -> Option<PendingShareChange> {
        Self::extend(env, &DataKey::PendingShareChange);
        env.storage()
            .persistent()
            .get(&DataKey::PendingShareChange)
    }

    pub fn delete_pending_share_change(env: &Env) {
        env.storage()
            .persistent()
            .remove(&DataKey::PendingShareChange);
    }

    // ── per-token accumulated balance ─────────────────────────────────────────

    pub fn load_balance(env: &Env, token: &Address) -> i128 {
        let key = DataKey::Balance(token.clone());
        Self::extend(env, &key);
        env.storage().persistent().get(&key).unwrap_or(0i128)
    }

    pub fn save_balance(env: &Env, token: &Address, amount: i128) {
        let key = DataKey::Balance(token.clone());
        env.storage().persistent().set(&key, &amount);
        Self::extend(env, &key);
    }
}
