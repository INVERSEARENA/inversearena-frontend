#![allow(dead_code)]
use crate::types::{PayoutError, PendingCap};
use soroban_sdk::{Address, BytesN, Env, contracttype};

pub trait StorageRepository<K, V> {
    fn has(&self, key: &K) -> bool;
    fn get(&self, key: &K) -> Option<V>;
    fn set(&self, key: &K, val: &V);
    fn remove(&self, key: &K);
}

pub trait TtlRepository<K> {
    fn extend_ttl(&self, key: &K, threshold: u32, extend_to: u32);
}

/// Minimum ledgers remaining before we extend a persistent entry's TTL
/// (~30 days at 5 s/ledger).
const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
/// Target TTL for persistent entries after extension (~1 year at 5 s/ledger).
const PERSISTENT_TTL_TARGET: u32 = 6_307_200;

/// Storage keys.
///
/// `Admin` and `Token` are persistent (not instance) so they share the same
/// TTL domain as `Paid` records — preventing a scenario where the contract
/// instance expires and admin/token disappear while paid records survive as
/// orphans (issue #1026).
#[contracttype]
pub(crate) enum DataKey {
    Admin,
    PendingAdmin,
    Token,
    /// Legacy (pre-#1632) caller-chosen idempotency ids. No longer written or
    /// read; kept so the variant is never reused with a different shape.
    Paid(u64),
    /// #1632: factory whose pool registry decides which arenas are genuine.
    Factory,
    /// #1632: amount paid for a payout id derived from `(arena, recipient)`.
    /// Replaces the caller-chosen `Paid(u64)` ids, which let one prize be paid
    /// under many ids.
    Payout(BytesN<32>),
    /// #1632: maximum total outflow per UTC day.
    DailyCap,
    /// #1632: a cap increase waiting out its timelock.
    PendingCap,
    /// #1632: total paid out on a given day (`timestamp / 86_400`). Temporary
    /// storage — a day's total is irrelevant once the day is over.
    Outflow(u64),
}

// ~6 months in ledgers (assuming 5s per ledger)
const PAYOUT_TTL_THRESHOLD: u32 = 3_153_600;
// ~1 year in ledgers
const PAYOUT_TTL_EXTEND_TO: u32 = 6_307_200;
/// A day's outflow total must outlive the day it counts (17_280 ledgers at
/// 5 s/ledger); two days leaves margin for ledger-time drift.
const OUTFLOW_TTL_LEDGERS: u32 = 34_560;


pub struct PayoutRepository<'a> {
    env: &'a Env,
}

impl<'a> PayoutRepository<'a> {
    pub fn new(env: &'a Env) -> Self {
        PayoutRepository { env }
    }
}

impl StorageRepository<DataKey, Address> for PayoutRepository<'_> {
    fn has(&self, key: &DataKey) -> bool {
        self.env.storage().persistent().has(key)
    }

    fn get(&self, key: &DataKey) -> Option<Address> {
        self.env.storage().persistent().get(key)
    }

    fn set(&self, key: &DataKey, val: &Address) {
        self.env.storage().persistent().set(key, val);
    }

    fn remove(&self, key: &DataKey) {
        self.env.storage().persistent().remove(key);
    }
}

// For DataKey::Paid which stores a bool
impl StorageRepository<DataKey, bool> for PayoutRepository<'_> {
    fn has(&self, key: &DataKey) -> bool {
        self.env.storage().persistent().has(key)
    }

    fn get(&self, key: &DataKey) -> Option<bool> {
        self.env.storage().persistent().get(key)
    }

    fn set(&self, key: &DataKey, val: &bool) {
        self.env.storage().persistent().set(key, val);
    }

    fn remove(&self, key: &DataKey) {
        self.env.storage().persistent().remove(key);
    }
}


impl TtlRepository<DataKey> for PayoutRepository<'_> {
    fn extend_ttl(&self, key: &DataKey, threshold: u32, extend_to: u32) {
        if self.env.storage().persistent().has(key) {
            self.env
                .storage()
                .persistent()
                .extend_ttl(key, threshold, extend_to);
        }
    }
}

pub struct PayoutStorage;

impl PayoutStorage {
    pub fn has_admin(env: &Env) -> bool {
        let repo = PayoutRepository::new(env);
        StorageRepository::<DataKey, Address>::has(&repo, &DataKey::Admin)
    }

    pub fn set_admin(env: &Env, admin: &Address) {
        let repo = PayoutRepository::new(env);
        repo.set(&DataKey::Admin, admin);
        repo.extend_ttl(
            &DataKey::Admin,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_admin(env: &Env) -> Result<Address, PayoutError> {
        let repo = PayoutRepository::new(env);
        let key = DataKey::Admin;
        let admin = repo
            .get(&key)
            .ok_or(PayoutError::NotInitialised)?;
        repo.extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
        Ok(admin)
    }

    pub fn save_pending_admin(env: &Env, admin: &Address) {
        let repo = PayoutRepository::new(env);
        let key = DataKey::PendingAdmin;
        repo.set(&key, admin);
        repo.extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn load_pending_admin(env: &Env) -> Option<Address> {
        let repo = PayoutRepository::new(env);
        let key = DataKey::PendingAdmin;
        let val = repo.get(&key);
        if val.is_some() {
            repo.extend_ttl(
                &key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_TARGET,
            );
        }
        val
    }

    pub fn delete_pending_admin(env: &Env) {
        let repo = PayoutRepository::new(env);
        StorageRepository::<DataKey, Address>::remove(&repo, &DataKey::PendingAdmin);
    }

    pub fn set_token(env: &Env, token: &Address) {
        let repo = PayoutRepository::new(env);
        repo.set(&DataKey::Token, token);
        repo.extend_ttl(
            &DataKey::Token,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_token(env: &Env) -> Result<Address, PayoutError> {
        let repo = PayoutRepository::new(env);
        let key = DataKey::Token;
        let token = repo
            .get(&key)
            .ok_or(PayoutError::NotInitialised)?;
        repo.extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
        Ok(token)
    }

    // ── #1632 — arena-validated payouts ───────────────────────────────────────

    pub fn set_factory(env: &Env, factory: &Address) {
        let repo = PayoutRepository::new(env);
        repo.set(&DataKey::Factory, factory);
        repo.extend_ttl(&DataKey::Factory, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_TARGET);
    }

    pub fn get_factory(env: &Env) -> Result<Address, PayoutError> {
        let repo = PayoutRepository::new(env);
        let factory = repo.get(&DataKey::Factory).ok_or(PayoutError::NotInitialised)?;
        repo.extend_ttl(&DataKey::Factory, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_TARGET);
        Ok(factory)
    }

    /// Amount already paid for `payout_id`, if any.
    pub fn paid_amount(env: &Env, payout_id: &BytesN<32>) -> Option<i128> {
        let key = DataKey::Payout(payout_id.clone());
        let paid: Option<i128> = env.storage().persistent().get(&key);
        if paid.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, PAYOUT_TTL_THRESHOLD, PAYOUT_TTL_EXTEND_TO);
        }
        paid
    }

    pub fn record_payout(env: &Env, payout_id: &BytesN<32>, amount: i128) {
        let key = DataKey::Payout(payout_id.clone());
        env.storage().persistent().set(&key, &amount);
        env.storage()
            .persistent()
            .extend_ttl(&key, PAYOUT_TTL_THRESHOLD, PAYOUT_TTL_EXTEND_TO);
    }

    pub fn set_daily_cap(env: &Env, cap: i128) {
        env.storage().persistent().set(&DataKey::DailyCap, &cap);
        env.storage().persistent().extend_ttl(
            &DataKey::DailyCap,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_daily_cap(env: &Env) -> Result<i128, PayoutError> {
        let cap: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::DailyCap)
            .ok_or(PayoutError::NotInitialised)?;
        env.storage().persistent().extend_ttl(
            &DataKey::DailyCap,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
        Ok(cap)
    }

    pub fn set_pending_cap(env: &Env, pending: &PendingCap) {
        env.storage().persistent().set(&DataKey::PendingCap, pending);
        env.storage().persistent().extend_ttl(
            &DataKey::PendingCap,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_pending_cap(env: &Env) -> Option<PendingCap> {
        env.storage().persistent().get(&DataKey::PendingCap)
    }

    pub fn clear_pending_cap(env: &Env) {
        env.storage().persistent().remove(&DataKey::PendingCap);
    }

    pub fn outflow(env: &Env, day: u64) -> i128 {
        env.storage()
            .temporary()
            .get(&DataKey::Outflow(day))
            .unwrap_or(0)
    }

    pub fn set_outflow(env: &Env, day: u64, total: i128) {
        let key = DataKey::Outflow(day);
        env.storage().temporary().set(&key, &total);
        env.storage()
            .temporary()
            .extend_ttl(&key, OUTFLOW_TTL_LEDGERS, OUTFLOW_TTL_LEDGERS);
    }
}
